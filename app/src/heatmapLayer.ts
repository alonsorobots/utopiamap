import maplibregl from 'maplibre-gl';
import type { CustomLayerInterface } from 'maplibre-gl';
import { compileFormula } from './formulaParser';
import {
  loadCatalog,
  hasRealData,
  getCachedTileData,
  tileDataKey,
  fetchTileData,
  setRepaintCallback,
  setTileArrivedCallback,
  flushAllRealDataCache,
} from './tileDataLoader';

// ── Constants ────────────────────────────────────────────────────────

const TILE_PX = 256;
const MAX_TILE_ZOOM = 10;
const MAX_CACHE = 768;

// ── Shaders ──────────────────────────────────────────────────────────

const VERT = `
  attribute vec2 a_pos;
  uniform mat4 u_matrix;
  uniform vec2 u_tile_offset;
  uniform vec2 u_tile_size;
  varying vec2 v_uv;

  void main() {
    v_uv = a_pos;
    vec2 merc = u_tile_offset + a_pos * u_tile_size;
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
  }
`;

const FRAG_COMMON = `
  uniform float u_prediction;

  vec3 cm_warm(float t) {
    vec3 c0 = vec3(0.002, 0.001, 0.020);
    vec3 c1 = vec3(0.190, 0.045, 0.400);
    vec3 c2 = vec3(0.570, 0.043, 0.503);
    vec3 c3 = vec3(0.890, 0.290, 0.200);
    vec3 c4 = vec3(0.988, 0.835, 0.282);
    if (t < 0.25) return mix(c0, c1, t * 4.0);
    if (t < 0.5)  return mix(c1, c2, (t - 0.25) * 4.0);
    if (t < 0.75) return mix(c2, c3, (t - 0.5) * 4.0);
    return mix(c3, c4, (t - 0.75) * 4.0);
  }

  vec3 cm_viridis(float t) {
    vec3 c0 = vec3(0.267, 0.004, 0.329);
    vec3 c1 = vec3(0.283, 0.141, 0.458);
    vec3 c2 = vec3(0.127, 0.566, 0.551);
    vec3 c3 = vec3(0.544, 0.774, 0.247);
    vec3 c4 = vec3(0.993, 0.906, 0.144);
    if (t < 0.25) return mix(c0, c1, t * 4.0);
    if (t < 0.5)  return mix(c1, c2, (t - 0.25) * 4.0);
    if (t < 0.75) return mix(c2, c3, (t - 0.5) * 4.0);
    return mix(c3, c4, (t - 0.75) * 4.0);
  }

  vec3 colormap(float t) {
    t = clamp(t, 0.0, 1.0);
    return u_prediction > 0.5 ? cm_viridis(t) : cm_warm(t);
  }
`;

function buildSingleAxisFrag(axisId: string): string {
  return `
  precision mediump float;
  uniform sampler2D u_data_${axisId};
  uniform sampler2D u_curve_${axisId};
  uniform float u_opacity;
  varying vec2 v_uv;

  ${FRAG_COMMON}

  void main() {
    vec4 sample = texture2D(u_data_${axisId}, v_uv);
    float raw = sample.r;
    float mask = sample.a;
    if (mask < 0.01) { gl_FragColor = vec4(0.0); return; }
    float f_${axisId} = texture2D(u_curve_${axisId}, vec2(raw, 0.5)).r;
    float result = f_${axisId};
    vec3 col = colormap(clamp(result, 0.0, 1.0));
    float alpha = clamp(result, 0.0, 1.0) * u_opacity * mask;
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;
}

function buildFormulaFrag(axisIds: string[], glslExpr: string): string {
  const uniforms = axisIds.map((id) =>
    `  uniform sampler2D u_data_${id};\n  uniform sampler2D u_curve_${id};`
  ).join('\n');

  const samples = axisIds.map((id) =>
    `    vec4 samp_${id} = texture2D(u_data_${id}, v_uv);\n    float raw_${id} = samp_${id}.r;\n    if (samp_${id}.a < 0.01) { gl_FragColor = vec4(0.0); return; }\n    float f_${id} = texture2D(u_curve_${id}, vec2(raw_${id}, 0.5)).r;`
  ).join('\n');

  return `
  precision mediump float;
${uniforms}
  uniform float u_opacity;
  varying vec2 v_uv;

  ${FRAG_COMMON}

  void main() {
${samples}
    float result = ${glslExpr};
    result = clamp(result, 0.0, 1.0);
    vec3 col = colormap(result);
    float alpha = result * u_opacity;
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;
}

// ── Module state ─────────────────────────────────────────────────────

let storedGL: WebGLRenderingContext | null = null;
let storedMap: maplibregl.Map | null = null;
let vertexBuffer: WebGLBuffer | null = null;

let currentProgram: WebGLProgram | null = null;
let currentLocations: {
  a_pos: number;
  u_matrix: WebGLUniformLocation | null;
  u_opacity: WebGLUniformLocation | null;
  u_prediction: WebGLUniformLocation | null;
  u_tile_offset: WebGLUniformLocation | null;
  u_tile_size: WebGLUniformLocation | null;
  dataUniforms: Map<string, WebGLUniformLocation>;
  curveUniforms: Map<string, WebGLUniformLocation>;
} | null = null;

let currentFormulaAxes: string[] = [];
let currentFormulaExpr: string | null = null;
let activeAxisId = 'temp';
let currentYear = 2020;
let currentScenario = 'historical';
let isPrediction = false;

// All axis IDs the heatmap layer can render. MUST be kept in sync with
// AXES in App.tsx -- otherwise picking that axis (or naming it in a
// formula) silently renders blank because the curve LUT texture is
// never created and the shader's curve sampler reads garbage.
const ALL_AXES = [
  // Climate / geography
  'temp', 'tvar', 'water', 'solar', 'wind', 'air', 'elev',
  // Energy
  'energy', 'e_consume', 'e_oil', 'e_coal', 'e_gas', 'e_nuke',
  'e_hydro', 'e_wind', 'e_solar', 'e_geo',
  // Society
  'agri', 'agrip', 'pop', 'gdp', 'inet', 'depv', 'hcare', 'travel', 'free',
  // Disasters (composite + per-hazard)
  'risk', 'eq', 'flood', 'cyclone', 'tsunami', 'volcano', 'drought',
  'wildfire', 'landslide',
  // Visual / interactive
  'vista', 'draw',
];

// ── Per-axis curve lookups (global, not tiled) ───────────────────────

const curveEntries = new Map<string, {
  data: Uint8Array;
  texture: WebGLTexture | null;
  dirty: boolean;
}>();

for (const id of ALL_AXES) {
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = i;
  curveEntries.set(id, { data, texture: null, dirty: true });
}

// ── Tile cache (LRU) ────────────────────────────────────────────────

interface TileCoord { z: number; x: number; y: number }

const tileCache = new Map<string, WebGLTexture>();
const realTileLoaded = new Set<string>();

function tileCacheKey(axis: string, z: number, x: number, y: number): string {
  return `${axis}/${z}/${x}/${y}`;
}

function touchTile(key: string) {
  const tex = tileCache.get(key);
  if (tex) {
    tileCache.delete(key);
    tileCache.set(key, tex);
  }
}

function evictTiles(gl: WebGLRenderingContext) {
  while (tileCache.size > MAX_CACHE) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    const tex = tileCache.get(oldest);
    if (tex) gl.deleteTexture(tex);
    tileCache.delete(oldest);
  }
}

// ── Tile coordinate math ─────────────────────────────────────────────

function mercYToLat01(mercY: number): number {
  const lat_rad = 2 * Math.atan(Math.exp(Math.PI * (1 - 2 * mercY))) - Math.PI / 2;
  return (Math.PI / 2 + lat_rad) / Math.PI;
}

function lngToMercX(lng: number): number {
  return (lng + 180) / 360;
}

function latToMercY(lat: number): number {
  const latRad = lat * Math.PI / 180;
  const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return 0.5 - mercN / (2 * Math.PI);
}

function getVisibleTiles(map: maplibregl.Map): TileCoord[] {
  const zoom = Math.max(0, Math.min(MAX_TILE_ZOOM, Math.floor(map.getZoom())));
  const n = 1 << zoom;
  const bounds = map.getBounds();

  const xMinF = lngToMercX(bounds.getWest()) * n;
  const xMaxF = lngToMercX(bounds.getEast()) * n;
  const yMinF = latToMercY(bounds.getNorth()) * n;
  const yMaxF = latToMercY(bounds.getSouth()) * n;

  const xMin = Math.floor(xMinF);
  const xMax = Math.floor(xMaxF);
  const yMin = Math.max(0, Math.floor(yMinF));
  const yMax = Math.min(n - 1, Math.floor(yMaxF));

  const tiles: TileCoord[] = [];
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

// ── Synthetic data generators (per-tile) ─────────────────────────────

function generateSyntheticTile(axisId: string, z: number, tileX: number, tileY: number): Uint8Array {
  const n = 1 << z;
  const wrappedX = ((tileX % n) + n) % n;
  const pixels = new Uint8Array(TILE_PX * TILE_PX * 4);

  // Temporal drift factor: 0 at 2000, positive in future, negative in past
  const yr = currentYear;
  const drift = (yr - 2000) / 100;

  for (let py = 0; py < TILE_PX; py++) {
    const mercY = (tileY + (py + 0.5) / TILE_PX) / n;
    const lat = mercYToLat01(mercY);
    for (let px = 0; px < TILE_PX; px++) {
      const lon = (wrappedX + (px + 0.5) / TILE_PX) / n;
      let v = 0;

      switch (axisId) {
        case 'temp': {
          const latFactor = Math.exp(-((lat - 0.6) ** 2) / 0.03);
          const lonWave = 0.5 + 0.5 * Math.sin(lon * Math.PI * 4);
          v = latFactor * 0.8 + lonWave * 0.2;
          v += drift * 0.15;
          break;
        }
        case 'tvar': {
          v = Math.abs(lat - 0.5) * 1.8;
          v = Math.min(1, v * v);
          v += drift * 0.1;
          break;
        }
        case 'water': {
          const equator = Math.exp(-((lat - 0.5) ** 2) / 0.08);
          const blob1 = Math.exp(-(((lon - 0.3) ** 2 + (lat - 0.55) ** 2)) / 0.01);
          const blob2 = Math.exp(-(((lon - 0.7) ** 2 + (lat - 0.45) ** 2)) / 0.015);
          const lakes = Math.exp(-(((lon - 0.55) ** 2 + (lat - 0.50) ** 2)) / 0.008);
          v = equator * 0.5 + blob1 * 0.7 + blob2 * 0.6 + lakes * 0.4;
          v -= drift * 0.08;
          break;
        }
        case 'solar': {
          const belt = 1.0 - Math.abs(lat - 0.5) * 2;
          v = Math.pow(Math.max(0, belt), 0.8);
          break;
        }
        case 'wind': {
          const midLat = Math.exp(-((lat - 0.35) ** 2) / 0.015) + Math.exp(-((lat - 0.65) ** 2) / 0.015);
          v = Math.min(1, midLat * 0.7 + 0.15);
          break;
        }
        case 'energy': {
          const oilGulf = Math.exp(-(((lon - 0.64) ** 2 + (lat - 0.42) ** 2)) / 0.004);
          const oilRu = Math.exp(-(((lon - 0.65) ** 2 + (lat - 0.28) ** 2)) / 0.008);
          const coalCn = Math.exp(-(((lon - 0.80) ** 2 + (lat - 0.37) ** 2)) / 0.006);
          const nucFr = Math.exp(-(((lon - 0.51) ** 2 + (lat - 0.33) ** 2)) / 0.002);
          const nucUs = Math.exp(-(((lon - 0.20) ** 2 + (lat - 0.37) ** 2)) / 0.005);
          v = Math.min(1, oilGulf * 0.9 + oilRu * 0.7 + coalCn * 0.8 + nucFr * 0.6 + nucUs * 0.5 + 0.05);
          v += drift * 0.05;
          break;
        }
        case 'agri': {
          const tropical = Math.exp(-((lat - 0.5) ** 2) / 0.05);
          const temperate = Math.exp(-((lat - 0.38) ** 2) / 0.02) + Math.exp(-((lat - 0.62) ** 2) / 0.02);
          v = Math.min(1, tropical * 0.6 + temperate * 0.5);
          v -= drift * 0.06;
          break;
        }
        case 'pop': {
          const spots = [
            { lx: 0.54, ly: 0.32, s: 0.004 },
            { lx: 0.51, ly: 0.36, s: 0.003 },
            { lx: 0.73, ly: 0.38, s: 0.005 },
            { lx: 0.78, ly: 0.35, s: 0.003 },
            { lx: 0.15, ly: 0.40, s: 0.004 },
            { lx: 0.60, ly: 0.50, s: 0.006 },
          ];
          for (const sp of spots) {
            v += Math.exp(-(((lon - sp.lx) ** 2 + (lat - sp.ly) ** 2)) / sp.s);
          }
          v = Math.min(1, v);
          v += drift * 0.12;
          break;
        }
        case 'gdp': {
          const na = Math.exp(-(((lon - 0.2) ** 2 + (lat - 0.38) ** 2)) / 0.01);
          const eu = Math.exp(-(((lon - 0.52) ** 2 + (lat - 0.32) ** 2)) / 0.005);
          const jp = Math.exp(-(((lon - 0.88) ** 2 + (lat - 0.37) ** 2)) / 0.003);
          const cn = Math.exp(-(((lon - 0.80) ** 2 + (lat - 0.38) ** 2)) / 0.006);
          v = Math.min(1, na * 0.8 + eu * 0.9 + jp * 0.85 + cn * drift * 1.5 + 0.05);
          break;
        }
        case 'cost': {
          const na = Math.exp(-(((lon - 0.2) ** 2 + (lat - 0.38) ** 2)) / 0.01);
          const eu = Math.exp(-(((lon - 0.52) ** 2 + (lat - 0.32) ** 2)) / 0.005);
          const au = Math.exp(-(((lon - 0.90) ** 2 + (lat - 0.62) ** 2)) / 0.004);
          v = Math.min(1, na * 0.7 + eu * 0.8 + au * 0.6 + 0.1);
          v += drift * 0.1;
          break;
        }
        case 'air': {
          const cn = Math.exp(-(((lon - 0.8) ** 2 + (lat - 0.38) ** 2)) / 0.008);
          const ind = Math.exp(-(((lon - 0.72) ** 2 + (lat - 0.43) ** 2)) / 0.006);
          v = Math.min(1, cn * 0.9 + ind * 0.85 + 0.05);
          v += drift * 0.08;
          break;
        }
        case 'elev': {
          const him = Math.exp(-(((lon - 0.73) ** 2 + (lat - 0.40) ** 2)) / 0.003);
          const andes = Math.exp(-(((lon - 0.21) ** 2 + (lat - 0.55) ** 2)) / 0.003);
          const alps = Math.exp(-(((lon - 0.53) ** 2 + (lat - 0.33) ** 2)) / 0.001);
          v = Math.min(1, him * 0.95 + andes * 0.7 + alps * 0.5 + 0.02);
          break;
        }
        case 'risk': {
          const ring = Math.exp(-(((lon - 0.85) ** 2 + (lat - 0.38) ** 2)) / 0.008);
          const sahel = Math.exp(-((lat - 0.46) ** 2) / 0.005) * (lon > 0.4 && lon < 0.6 ? 1 : 0);
          v = Math.min(1, ring * 0.6 + sahel * 0.5 + 0.1);
          v += drift * 0.05;
          break;
        }
        case 'hcare': {
          v = Math.min(1, 0.8 * Math.exp(-((lon - 0.5) ** 2 + (lat - 0.5) ** 2) / 0.05));
          break;
        }
        case 'travel': {
          const u_centers = Math.exp(-(((lon - 0.5) ** 2 + (lat - 0.5) ** 2)) / 0.02);
          const u_centers2 = Math.exp(-(((lon - 0.3) ** 2 + (lat - 0.4) ** 2)) / 0.01);
          v = Math.min(1, u_centers * 0.9 + u_centers2 * 0.8 + 0.1);
          break;
        }
        default:
          v = 0.5;
      }

      const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
      const idx = (py * TILE_PX + px) * 4;
      pixels[idx] = byte;
      pixels[idx + 1] = byte;
      pixels[idx + 2] = byte;
      pixels[idx + 3] = 255;
    }
  }
  return pixels;
}

function ensureTileTexture(gl: WebGLRenderingContext, axis: string, tile: TileCoord): WebGLTexture {
  const n = 1 << tile.z;
  const wrappedX = ((tile.x % n) + n) % n;
  const key = tileCacheKey(axis, tile.z, wrappedX, tile.y);

  const cached = tileCache.get(key);
  if (cached) {
    touchTile(key);
    if (dirtyDrawTiles.has(key)) {
      dirtyDrawTiles.delete(key);
      const pixels = generateDrawTile(tile.z, tile.x, tile.y);
      gl.bindTexture(gl.TEXTURE_2D, cached);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_PX, TILE_PX, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    // Check if real data has arrived for a tile currently showing stale/synthetic data
    if (axis !== 'draw' && hasRealData(axis)) {
      const realKey = tileDataKey(axis, tile.z, wrappedX, tile.y);
      const realData = getCachedTileData(realKey);
      if (realData && !realTileLoaded.has(key)) {
        realTileLoaded.add(key);
        gl.bindTexture(gl.TEXTURE_2D, cached);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_PX, TILE_PX, gl.RGBA, gl.UNSIGNED_BYTE, realData);
      } else if (!realData && !realTileLoaded.has(key)) {
        fetchTileData(axis, tile.z, tile.x, tile.y, currentYear, currentScenario);
      }
    }
    return cached;
  }

  let pixels: Uint8Array;
  if (axis === 'draw') {
    pixels = generateDrawTile(tile.z, tile.x, tile.y);
  } else if (hasRealData(axis)) {
    const realKey = tileDataKey(axis, tile.z, wrappedX, tile.y);
    const realData = getCachedTileData(realKey);
    if (realData) {
      pixels = realData;
      realTileLoaded.add(key);
    } else {
      fetchTileData(axis, tile.z, tile.x, tile.y, currentYear, currentScenario);
      // Blank tile while loading -- all zeros = transparent via additive blend
      pixels = new Uint8Array(TILE_PX * TILE_PX * 4);
    }
  } else {
    pixels = generateSyntheticTile(axis, tile.z, tile.x, tile.y);
  }

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TILE_PX, TILE_PX, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  dirtyDrawTiles.delete(key);

  tileCache.set(key, tex);
  evictTiles(gl);
  return tex;
}

// ── Paintable draw layer (quadtree) ──────────────────────────────────
// 17 grid levels (0-16). Level L has a 2^L x 2^L grid.
// Rendering at map zoom Z uses level Z+8, so each tile pixel = one cell.
// Perfect 2x2 subdivisions: a cell at level L has 4 children at level L+1.
//
// paintedAt[L]: cells directly painted at level L (numeric keys: cy * 2^L + cx)
// drawHas[L]:   cells that have any paint (self or descendant) -- for zoom-out
//
// A rendered pixel is "on" if:
//   drawHas[renderLevel] contains it  (self or finer paint exists here), OR
//   any ancestor in paintedAt covers it (inherited from coarser paint).

const DRAW_LEVELS = 17;
const DRAW_MAX = 16;

const paintedAt: Set<number>[] = Array.from({ length: DRAW_LEVELS }, () => new Set());
const drawHas: Set<number>[] = Array.from({ length: DRAW_LEVELS }, () => new Set());

function dKey(level: number, cx: number, cy: number): number {
  return cy * (1 << level) + cx;
}

function paintCellInternal(level: number, cx: number, cy: number): boolean {
  const key = dKey(level, cx, cy);
  if (paintedAt[level].has(key)) return false;
  paintedAt[level].add(key);
  let x = cx, y = cy;
  for (let l = level; l >= 0; l--) {
    const k = dKey(l, x, y);
    if (drawHas[l].has(k)) break;
    drawHas[l].add(k);
    x >>= 1;
    y >>= 1;
  }
  return true;
}

function rebuildAllDrawHas() {
  for (let l = 0; l < DRAW_LEVELS; l++) drawHas[l].clear();
  for (let l = 0; l < DRAW_LEVELS; l++) {
    for (const k of paintedAt[l]) {
      const gs = 1 << l;
      let py = (k / gs) | 0;
      let px = k - py * gs;
      for (let al = l; al >= 0; al--) {
        const ak = dKey(al, px, py);
        if (drawHas[al].has(ak)) break;
        drawHas[al].add(ak);
        px >>= 1;
        py >>= 1;
      }
    }
  }
}

// Erase a single cell, handling ancestor splitting and descendant erasure.
// Does NOT rebuild drawHas -- caller must call rebuildAllDrawHas() after batch.
function eraseCellWork(level: number, cx: number, cy: number): boolean {
  let changed = false;

  // 1. Erase direct paint at this level
  if (paintedAt[level].has(dKey(level, cx, cy))) {
    paintedAt[level].delete(dKey(level, cx, cy));
    changed = true;
  }

  // 2. Erase all descendant paint within this cell
  for (let l = level + 1; l < DRAW_LEVELS; l++) {
    if (paintedAt[l].size === 0) continue;
    const shift = l - level;
    if (shift > 8) break;
    const startX = cx << shift;
    const startY = cy << shift;
    const count = 1 << shift;
    for (let dy = 0; dy < count; dy++) {
      for (let dx = 0; dx < count; dx++) {
        const k = dKey(l, startX + dx, startY + dy);
        if (paintedAt[l].has(k)) {
          paintedAt[l].delete(k);
          changed = true;
        }
      }
    }
  }

  // 3. Split ancestors: if an ancestor covers this cell, remove it and
  //    re-paint the 3 sibling sub-cells at each level down to this one
  for (let a = level - 1; a >= 0; a--) {
    const ancX = cx >> (level - a);
    const ancY = cy >> (level - a);
    if (!paintedAt[a].has(dKey(a, ancX, ancY))) continue;

    paintedAt[a].delete(dKey(a, ancX, ancY));
    changed = true;

    for (let l = a + 1; l <= level; l++) {
      const pathX = cx >> (level - l);
      const pathY = cy >> (level - l);
      const parentX = pathX >> 1;
      const parentY = pathY >> 1;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const childX = parentX * 2 + dx;
          const childY = parentY * 2 + dy;
          if (childX !== pathX || childY !== pathY) {
            paintedAt[l].add(dKey(l, childX, childY));
          }
        }
      }
    }
    break;
  }

  return changed;
}

function eraseCellInternal(level: number, cx: number, cy: number): boolean {
  const changed = eraseCellWork(level, cx, cy);
  if (changed) rebuildAllDrawHas();
  return changed;
}

// @ts-ignore
function rebuildHasUp(level: number, cx: number, cy: number) {
  let has = paintedAt[level].has(dKey(level, cx, cy));
  if (!has && level < DRAW_MAX) {
    for (let dy = 0; dy < 2 && !has; dy++)
      for (let dx = 0; dx < 2 && !has; dx++)
        has = drawHas[level + 1].has(dKey(level + 1, cx * 2 + dx, cy * 2 + dy));
  }
  const key = dKey(level, cx, cy);
  if (has) {
    drawHas[level].add(key);
  } else {
    if (!drawHas[level].has(key)) return;
    drawHas[level].delete(key);
    if (level > 0) rebuildHasUp(level - 1, cx >> 1, cy >> 1);
  }
}


function generateDrawTile(z: number, tileX: number, tileY: number): Uint8Array {
  const n = 1 << z;
  const wrappedX = ((tileX % n) + n) % n;
  const pixels = new Uint8Array(TILE_PX * TILE_PX * 4);
  const level = Math.min(DRAW_MAX, z + 8);
  const cellsPerTile = 1 << (level - z);
  const ppc = TILE_PX / cellsPerTile;
  const baseCX = wrappedX * cellsPerTile;
  const baseCY = tileY * cellsPerTile;
  const gs = 1 << level;

  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  if (drawHas[0].size === 0) return pixels;

  if (drawHas[level].size > 0) {
    for (const key of drawHas[level]) {
      const cy = (key / gs) | 0;
      const cx = key - cy * gs;
      const rx = (cx - baseCX) * ppc;
      const ry = (cy - baseCY) * ppc;
      if (rx >= TILE_PX || ry >= TILE_PX || rx + ppc <= 0 || ry + ppc <= 0) continue;
      for (let dy = 0; dy < ppc; dy++) {
        const py = ry + dy;
        if (py < 0 || py >= TILE_PX) continue;
        const rowOff = py * TILE_PX;
        for (let dx = 0; dx < ppc; dx++) {
          const px = rx + dx;
          if (px < 0 || px >= TILE_PX) continue;
          const idx = (rowOff + px) * 4;
          pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
        }
      }
    }
  }

  for (let l = level - 1; l >= 0; l--) {
    if (paintedAt[l].size === 0) continue;
    const shift = level - l;
    const blockCells = 1 << shift;
    // @ts-ignore
    const blockPx = blockCells * ppc;
    const ax0 = baseCX >> shift;
    const ay0 = baseCY >> shift;
    const ax1 = (baseCX + cellsPerTile - 1) >> shift;
    const ay1 = (baseCY + cellsPerTile - 1) >> shift;
    const ancGs = 1 << l;
    for (let ay = ay0; ay <= ay1; ay++) {
      for (let ax = ax0; ax <= ax1; ax++) {
        if (!paintedAt[l].has(ay * ancGs + ax)) continue;
        const sx = Math.max(0, (ax * blockCells - baseCX) * ppc);
        const sy = Math.max(0, (ay * blockCells - baseCY) * ppc);
        const ex = Math.min(TILE_PX, ((ax + 1) * blockCells - baseCX) * ppc);
        const ey = Math.min(TILE_PX, ((ay + 1) * blockCells - baseCY) * ppc);
        for (let py = sy; py < ey; py++) {
          const rowOff = py * TILE_PX;
          for (let px = sx; px < ex; px++) {
            const idx = (rowOff + px) * 4;
            pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
          }
        }
      }
    }
  }

  return pixels;
}

const dirtyDrawTiles = new Set<string>();

function invalidateDrawCache() {
  for (const key of tileCache.keys()) {
    if (key.startsWith('draw/')) dirtyDrawTiles.add(key);
  }
}

export function drawPaint(level: number, cx: number, cy: number) {
  if (!paintCellInternal(level, cx, cy)) return;
  invalidateDrawCache();
  storedMap?.triggerRepaint();
}

export function drawErase(level: number, cx: number, cy: number) {
  if (!eraseCellInternal(level, cx, cy)) return;
  invalidateDrawCache();
  storedMap?.triggerRepaint();
}

export function drawPaintCircle(level: number, cx: number, cy: number, r: number) {
  const gs = 1 << level;
  const rr = (r + 0.5) * (r + 0.5);
  let changed = false;
  for (let dy = -r; dy <= r; dy++) {
    const ny = cy + dy;
    if (ny < 0 || ny >= gs) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      const nx = ((cx + dx) % gs + gs) % gs;
      if (paintCellInternal(level, nx, ny)) changed = true;
    }
  }
  if (changed) { invalidateDrawCache(); storedMap?.triggerRepaint(); }
}

export function drawEraseCircle(level: number, cx: number, cy: number, r: number) {
  const gs = 1 << level;
  const rr = (r + 0.5) * (r + 0.5);
  let changed = false;
  for (let dy = -r; dy <= r; dy++) {
    const ny = cy + dy;
    if (ny < 0 || ny >= gs) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      const nx = ((cx + dx) % gs + gs) % gs;
      if (eraseCellWork(level, nx, ny)) changed = true;
    }
  }
  if (changed) {
    rebuildAllDrawHas();
    invalidateDrawCache();
    storedMap?.triggerRepaint();
  }
}

export function drawCount(): number {
  let count = 0;
  for (const s of paintedAt) count += s.size;
  return count;
}

// ── Painted-mask serialization (for share links) ────────────────────
//
// PaintedMask is a compact wire format: one entry per quadtree level that
// has any painted cells, with the cell keys delta-encoded so consecutive
// keys at the same level shrink to small ints in JSON.

export interface PaintedMask {
  v: 1;
  // Keys are stored as delta-encoded arrays per level: [first, d1, d2, ...]
  // where d_i = key_i - key_{i-1}. Levels with no paint are omitted.
  levels: Record<number, number[]>;
}

export function exportPaintedMask(): PaintedMask | null {
  const levels: Record<number, number[]> = {};
  let totalCells = 0;
  for (let l = 0; l < DRAW_LEVELS; l++) {
    if (paintedAt[l].size === 0) continue;
    const sorted = Array.from(paintedAt[l]).sort((a, b) => a - b);
    const deltas: number[] = new Array(sorted.length);
    deltas[0] = sorted[0];
    for (let i = 1; i < sorted.length; i++) deltas[i] = sorted[i] - sorted[i - 1];
    levels[l] = deltas;
    totalCells += sorted.length;
  }
  if (totalCells === 0) return null;
  return { v: 1, levels };
}

export function importPaintedMask(mask: PaintedMask | null | undefined) {
  for (let l = 0; l < DRAW_LEVELS; l++) paintedAt[l].clear();
  if (mask && mask.v === 1 && mask.levels) {
    for (const [lStr, deltas] of Object.entries(mask.levels)) {
      const l = Number(lStr);
      if (!Number.isFinite(l) || l < 0 || l >= DRAW_LEVELS) continue;
      let key = 0;
      for (let i = 0; i < deltas.length; i++) {
        key += deltas[i];
        paintedAt[l].add(key);
      }
    }
  }
  rebuildAllDrawHas();
  invalidateDrawCache();
  storedMap?.triggerRepaint();
}

// ── Public API ───────────────────────────────────────────────────────

export function updateLookupTexture(axisId: string, values: Float32Array) {
  let entry = curveEntries.get(axisId);
  if (!entry) {
    const data = new Uint8Array(256);
    entry = { data, texture: null, dirty: true };
    curveEntries.set(axisId, entry);
  }
  for (let i = 0; i < 256; i++) {
    entry.data[i] = Math.round(Math.max(0, Math.min(1, values[i])) * 255);
  }
  entry.dirty = true;
}

export function getTimeYear(): number {
  return currentYear;
}

export function setTimeYear(year: number, scenario: string = 'historical') {
  if (year === currentYear && scenario === currentScenario) return;
  currentYear = year;
  currentScenario = scenario;
  isPrediction = scenario !== 'historical';
  // Bump the data cache epoch so stale tiles are re-fetched,
  // but keep old textures on-screen as fallback until new data arrives.
  flushAllRealDataCache();
  realTileLoaded.clear();
  storedMap?.triggerRepaint();
}

export function setActiveAxis(axisId: string) {
  if (activeAxisId === axisId) return;
  activeAxisId = axisId;
  if (currentFormulaAxes.length === 0 && storedGL) {
    rebuildProgram(storedGL, [axisId], null);
  }
}

export interface FormulaError {
  message: string;
}

export function setFormula(formulaStr: string): FormulaError | null {
  if (!storedGL) return { message: 'WebGL not ready' };

  const trimmed = formulaStr.trim();
  if (trimmed === '') {
    currentFormulaAxes = [];
    currentFormulaExpr = null;
    rebuildProgram(storedGL, [activeAxisId], null);
    return null;
  }

  try {
    const { glsl, axes } = compileFormula(trimmed);
    const axisArr = Array.from(axes);

    const known = new Set(ALL_AXES);
    const unknown = axisArr.filter((a) => !known.has(a));
    if (unknown.length > 0) {
      return { message: `Unknown: ${unknown.join(', ')}` };
    }
    if (axisArr.length > 4) {
      return { message: 'Max 4 axes in a formula' };
    }

    currentFormulaAxes = axisArr;
    currentFormulaExpr = glsl;
    rebuildProgram(storedGL, axisArr, glsl);
    return null;
  } catch (e: any) {
    return { message: e.message ?? 'Parse error' };
  }
}

// ── Hover value reader ──────────────────────────────────────────────

export interface HoverValue {
  rawNorm: number;
  curveValue: number;
  isFormula: boolean;
}

export function readValueAtLngLat(lng: number, lat: number): HoverValue | null {
  if (!storedMap) return null;

  const z = Math.max(0, Math.min(MAX_TILE_ZOOM, Math.floor(storedMap.getZoom())));
  const n = 1 << z;

  const mercX = (lng + 180) / 360;
  const latRad = lat * Math.PI / 180;
  const mercY = 0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);

  if (mercY < 0 || mercY >= 1) return null;

  const tileX = Math.floor(mercX * n);
  const tileY = Math.floor(mercY * n);
  const wrappedX = ((tileX % n) + n) % n;
  const u = mercX * n - tileX;
  const v = mercY * n - tileY;
  const px = Math.min(TILE_PX - 1, Math.max(0, Math.floor(u * TILE_PX)));
  const py = Math.min(TILE_PX - 1, Math.max(0, Math.floor(v * TILE_PX)));

  const axes = currentFormulaAxes.length > 0 ? currentFormulaAxes : [activeAxisId];
  const isFormula = currentFormulaAxes.length > 0;

  if (!isFormula) {
    const axId = axes[0];
    if (axId === 'draw') return null;
    const key = tileDataKey(axId, z, wrappedX, tileY);
    const data = getCachedTileData(key);
    if (!data) return null;
    const idx = (py * TILE_PX + px) * 4;
    const rawByte = data[idx];
    if (rawByte < 1) return null;
    const rawNorm = rawByte / 255;
    const curve = curveEntries.get(axId);
    const curveValue = curve ? curve.data[rawByte] / 255 : rawNorm;
    return { rawNorm, curveValue, isFormula: false };
  }

  // Formula mode: read each axis, apply curves, evaluate
  const fVals: Record<string, number> = {};
  for (const axId of axes) {
    const key = tileDataKey(axId, z, wrappedX, tileY);
    const data = getCachedTileData(key);
    if (!data) return null;
    const idx = (py * TILE_PX + px) * 4;
    const rawByte = data[idx];
    if (rawByte < 1) return null;
    const curve = curveEntries.get(axId);
    fVals[`f_${axId}`] = curve ? curve.data[rawByte] / 255 : rawByte / 255;
  }

  if (!currentFormulaExpr) return null;

  try {
    let expr = currentFormulaExpr;
    for (const [name, val] of Object.entries(fVals)) {
      expr = expr.replace(new RegExp(`\\b${name}\\b`, 'g'), val.toString());
    }
    const result = Math.max(0, Math.min(1, Function(`"use strict"; return (${expr});`)()));
    return { rawNorm: result, curveValue: result, isFormula: true };
  } catch {
    return null;
  }
}

// ── Shader helpers ───────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile error: ${info}`);
  }
  return s;
}

function linkProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function rebuildProgram(gl: WebGLRenderingContext, axes: string[], glslExpr: string | null) {
  const fragSrc = glslExpr
    ? buildFormulaFrag(axes, glslExpr)
    : buildSingleAxisFrag(axes[0]);

  let prog: WebGLProgram;
  try {
    prog = linkProgram(gl, VERT, fragSrc);
  } catch {
    return;
  }

  if (currentProgram) gl.deleteProgram(currentProgram);
  currentProgram = prog;

  const dataUniforms = new Map<string, WebGLUniformLocation>();
  const curveUniforms = new Map<string, WebGLUniformLocation>();
  for (const id of axes) {
    const dLoc = gl.getUniformLocation(prog, `u_data_${id}`);
    const cLoc = gl.getUniformLocation(prog, `u_curve_${id}`);
    if (dLoc) dataUniforms.set(id, dLoc);
    if (cLoc) curveUniforms.set(id, cLoc);
  }

  currentLocations = {
    a_pos: gl.getAttribLocation(prog, 'a_pos'),
    u_matrix: gl.getUniformLocation(prog, 'u_matrix'),
    u_opacity: gl.getUniformLocation(prog, 'u_opacity'),
    u_prediction: gl.getUniformLocation(prog, 'u_prediction'),
    u_tile_offset: gl.getUniformLocation(prog, 'u_tile_offset'),
    u_tile_size: gl.getUniformLocation(prog, 'u_tile_size'),
    dataUniforms,
    curveUniforms,
  };
}

function ensureCurveTexture(gl: WebGLRenderingContext, axisId: string) {
  let entry = curveEntries.get(axisId);
  if (!entry) {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    entry = { data, texture: null, dirty: true };
    curveEntries.set(axisId, entry);
  }
  if (!entry.texture) {
    entry.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 256, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, entry.data);
    entry.dirty = false;
  }
}

// ── The MapLibre custom layer ────────────────────────────────────────

export function createHeatmapLayer(): CustomLayerInterface {
  return {
    id: 'utopia-heatmap',
    type: 'custom',
    renderingMode: '2d',

    onAdd(map, gl) {
      storedMap = map;
      storedGL = gl;

      vertexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,  1, 0,
        0, 1,  1, 1,
      ]), gl.STATIC_DRAW);

      for (const id of ALL_AXES) {
        ensureCurveTexture(gl, id);
      }

      rebuildProgram(gl, [activeAxisId], null);

      setRepaintCallback(() => map.triggerRepaint());
      // When tile pixels land in the data cache, push them straight to the
      // matching GL texture if it already exists, then ask for a repaint.
      // This makes "data appears the moment it arrives" work even if the
      // browser/MapLibre swallows our triggerRepaint() (which we observed on
      // initial load: tiles would sit blank until the user wiggled a curve
      // vertex or changed axis to force another render pass).
      setTileArrivedCallback((axis, z, x, y, pixels) => {
        const key = tileCacheKey(axis, z, x, y);
        const tex = tileCache.get(key);
        if (tex) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_PX, TILE_PX, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          realTileLoaded.add(key);
        }
        map.triggerRepaint();
      });
      loadCatalog().then(() => {
        // Drop any synthetic-data textures that were cached during the brief
        // window before the catalog arrived. Otherwise the cache-hit path
        // keeps serving synthetic pixels for the initial viewport until the
        // user pans/zooms enough to evict them -- which manifests as "the
        // default axis shows no real data until I move the timeline or
        // change feature". Forcing a fresh cache miss routes every visible
        // tile through the unambiguous fetch-real-data path.
        for (const tex of tileCache.values()) gl.deleteTexture(tex);
        tileCache.clear();
        realTileLoaded.clear();
        map.triggerRepaint();
      });
    },

    prerender() {
      // Clear the dirty set for tiles no longer in cache (evicted)
      for (const key of dirtyDrawTiles) {
        if (!tileCache.has(key)) dirtyDrawTiles.delete(key);
      }
    },

    render(gl, _args) {
      if (!currentProgram || !currentLocations || !storedMap) return;

      // Upload any dirty curve textures
      for (const [, entry] of curveEntries) {
        if (entry.dirty && entry.texture) {
          gl.bindTexture(gl.TEXTURE_2D, entry.texture);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, entry.data);
          entry.dirty = false;
        }
      }

      gl.useProgram(currentProgram);

      const transform = (storedMap as any).transform;
      const mercatorMatrix = transform.mercatorMatrix ?? transform._mercatorMatrix;
      if (currentLocations.u_matrix)
        gl.uniformMatrix4fv(currentLocations.u_matrix, false, mercatorMatrix);
      if (currentLocations.u_opacity)
        gl.uniform1f(currentLocations.u_opacity, 0.65);
      if (currentLocations.u_prediction)
        gl.uniform1f(currentLocations.u_prediction, isPrediction ? 1.0 : 0.0);

      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.enableVertexAttribArray(currentLocations.a_pos);
      gl.vertexAttribPointer(currentLocations.a_pos, 2, gl.FLOAT, false, 0, 0);

      const axes = currentFormulaAxes.length > 0 ? currentFormulaAxes : [activeAxisId];
      const numAxes = axes.length;

      // Bind curve lookup textures to high texture units (stable across tiles).
      // Lazily create the curve LUT if an axis isn't in ALL_AXES yet -- otherwise
      // the shader's u_curve_<id> sampler binds to texture unit 0 (a 256x256
      // tile texture, not a 256x1 LUT) and reads garbage, which manifests as
      // "this axis renders black/blank no matter what".
      for (let i = 0; i < numAxes; i++) {
        const id = axes[i];
        ensureCurveTexture(gl, id);
        const curveEntry = curveEntries.get(id);
        if (!curveEntry?.texture) continue;
        const unit = numAxes + i;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, curveEntry.texture);
        const cLoc = currentLocations.curveUniforms.get(id);
        if (cLoc) gl.uniform1i(cLoc, unit);
      }

      // Additive blending: heatmap glows on top of the dark base map
      gl.blendFunc(gl.ONE, gl.ONE);

      const tiles = getVisibleTiles(storedMap);
      for (const tile of tiles) {
        const n = 1 << tile.z;
        const tileSize = 1 / n;

        if (currentLocations.u_tile_offset)
          gl.uniform2f(currentLocations.u_tile_offset, tile.x * tileSize, tile.y * tileSize);
        if (currentLocations.u_tile_size)
          gl.uniform2f(currentLocations.u_tile_size, tileSize, tileSize);

        // Bind data textures for this tile (low texture units)
        for (let i = 0; i < numAxes; i++) {
          const id = axes[i];
          gl.activeTexture(gl.TEXTURE0 + i);
          const dataTex = ensureTileTexture(gl, id, tile);
          gl.bindTexture(gl.TEXTURE_2D, dataTex);
          const dLoc = currentLocations.dataUniforms.get(id);
          if (dLoc) gl.uniform1i(dLoc, i);
        }

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Restore MapLibre's default premultiplied alpha blend
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    },
  };
}
