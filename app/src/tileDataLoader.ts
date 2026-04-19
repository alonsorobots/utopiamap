import { PMTiles } from 'pmtiles';

export interface CatalogEntry {
  static: boolean;
  years?: number[];
  projections?: Record<string, number[]>;
  // Optional content-hashed filename (e.g. "elev.a1b2c3d4.pmtiles") for
  // static archives. When present we serve this exact name so the asset
  // can be cached forever; bumping the file content bumps the hash and
  // invalidates the cache automatically.
  file?: string;
}

export type Catalog = Record<string, CatalogEntry>;

let catalog: Catalog | null = null;
let catalogPromise: Promise<Catalog | null> | null = null;

// In dev/preview, vite serves tiles at /data/tiles via the serveDataTiles
// middleware. In production set VITE_TILES_BASE (e.g. https://tiles.utopiamap.com)
// so the bundle fetches from the R2 custom-domain CDN instead.
const TILES_BASE = (import.meta.env.VITE_TILES_BASE as string | undefined) || '/data/tiles';
const TILE_PX = 256;

const archives = new Map<string, PMTiles>();
const tileDataCache = new Map<string, Uint8Array>();
const pendingFetches = new Set<string>();
const notFoundTiles = new Set<string>();
let cacheEpoch = 0;
const tileEpoch = new Map<string, number>();

let repaintCallback: (() => void) | null = null;

export function setRepaintCallback(cb: () => void) {
  repaintCallback = cb;
}

export async function loadCatalog(): Promise<Catalog | null> {
  if (catalog) return catalog;
  if (catalogPromise) return catalogPromise;

  catalogPromise = fetch(`${TILES_BASE}/catalog.json`)
    .then((r) => r.ok ? r.json() as Promise<Catalog> : null)
    .then((c) => { catalog = c; return c; })
    .catch(() => null);

  return catalogPromise;
}

export function getCatalog(): Catalog | null {
  return catalog;
}

function nearestYear(years: number[], target: number): number {
  let best = years[0];
  let bestDist = Math.abs(best - target);
  for (const y of years) {
    const d = Math.abs(y - target);
    if (d < bestDist) { best = y; bestDist = d; }
  }
  return best;
}

function resolveArchiveUrl(axis: string, year: number | null, scenario: string | null): string {
  if (!catalog) return '';
  const entry = catalog[axis];
  if (!entry) return '';

  if (entry.static) {
    const fname = entry.file ?? `${axis}.pmtiles`;
    return `${TILES_BASE}/${axis}/${fname}`;
  }

  const hasProjections = !!entry.projections && Object.keys(entry.projections).length > 0;

  // Climate-projection scenarios: pick a future tile keyed by both scenario and year.
  if (year !== null && scenario && scenario !== 'historical' && entry.projections?.[scenario]?.length) {
    const projYears = entry.projections[scenario];
    const snapped = nearestYear(projYears, year);
    return `${TILES_BASE}/${axis}/${axis}_${scenario}_${snapped}.pmtiles`;
  }

  if (year !== null && entry.years && entry.years.length > 0) {
    const maxYear = Math.max(...entry.years);
    // For axes without projections, don't fabricate future data.  For axes that
    // do have projections we always have something sensible to show, so the
    // historical branch is allowed to keep snapping to the nearest year even
    // past maxYear (the visual cutoff between current/projected is handled by
    // the slider colouring, not by hiding tiles).
    if (year > maxYear && !hasProjections) return '';
    const snapped = nearestYear(entry.years, year);
    return `${TILES_BASE}/${axis}/${axis}_${snapped}.pmtiles`;
  }

  return '';
}

function getArchive(url: string): PMTiles {
  let pm = archives.get(url);
  if (!pm) {
    pm = new PMTiles(url);
    archives.set(url, pm);
  }
  return pm;
}

export function hasRealData(axis: string): boolean {
  return catalog !== null && axis in catalog;
}

export function isAxisTemporal(axis: string): boolean {
  if (!catalog) return false;
  const entry = catalog[axis];
  if (!entry) return false;
  if (entry.static) return false;
  const hasMultipleYears = !!entry.years && entry.years.length > 1;
  const hasProjections = !!entry.projections && Object.keys(entry.projections).length > 0;
  return hasMultipleYears || hasProjections;
}

export function getTemporalRange(axis: string): { first: number; last: number } | null {
  if (!catalog) return null;
  const entry = catalog[axis];
  if (!entry || entry.static) return null;
  const ys = entry.years && entry.years.length > 0 ? [...entry.years] : [];
  if (ys.length < 2 && !(entry.projections && Object.keys(entry.projections).length > 0)) return null;
  if (ys.length === 0) return null;
  const sorted = ys.sort((a, b) => a - b);
  return { first: sorted[0], last: sorted[sorted.length - 1] };
}

export function getProjections(axis: string): Record<string, number[]> | null {
  if (!catalog) return null;
  const entry = catalog[axis];
  if (!entry || !entry.projections) return null;
  return entry.projections;
}

/**
 * Sorted, de-duplicated list of every year for which this axis has a tile
 * (historical years + every projection year, across all scenarios).  Used by
 * the time slider to draw faint tick marks at each data point.
 */
export function getAllAxisYears(axis: string): number[] {
  if (!catalog) return [];
  const entry = catalog[axis];
  if (!entry || entry.static) return [];
  const set = new Set<number>();
  for (const y of entry.years ?? []) set.add(y);
  if (entry.projections) {
    for (const ys of Object.values(entry.projections)) {
      for (const y of ys) set.add(y);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function getCachedTileData(key: string): Uint8Array | undefined {
  const data = tileDataCache.get(key);
  if (!data) return undefined;
  if ((tileEpoch.get(key) ?? -1) !== cacheEpoch) return undefined;
  return data;
}

export function tileDataKey(axis: string, z: number, x: number, y: number): string {
  return `${axis}/${z}/${x}/${y}`;
}

export function fetchTileData(
  axis: string,
  z: number,
  x: number,
  y: number,
  year: number | null,
  scenario: string | null,
) {
  if (!catalog || !(axis in catalog)) return;

  const n = 1 << z;
  const wrappedX = ((x % n) + n) % n;
  const key = tileDataKey(axis, z, wrappedX, y);

  if (pendingFetches.has(key)) return;

  const cached = tileDataCache.has(key) && (tileEpoch.get(key) ?? -1) === cacheEpoch;
  if (cached) return;

  if (notFoundTiles.has(key) && (tileEpoch.get(key) ?? -1) === cacheEpoch) return;

  const url = resolveArchiveUrl(axis, year, scenario);
  if (!url) {
    // No data for this axis/year -- store blank tile so we don't show stale data
    tileDataCache.set(key, new Uint8Array(TILE_PX * TILE_PX * 4));
    tileEpoch.set(key, cacheEpoch);
    return;
  }

  pendingFetches.add(key);
  fetchWithOverzoom(getArchive(url), z, wrappedX, y, key);
}

async function fetchWithOverzoom(
  pm: PMTiles,
  z: number,
  x: number,
  y: number,
  key: string,
) {
  const MAX_PARENT_LEVELS = 6;

  for (let dz = 0; dz <= MAX_PARENT_LEVELS && z - dz >= 0; dz++) {
    const pz = z - dz;
    const px = x >> dz;
    const py = y >> dz;

    try {
      const result = await pm.getZxy(pz, px, py);
      if (!result || !result.data) continue;

      const pixels = dz === 0
        ? await decodePngToRGBA(result.data)
        : await decodeAndCropTile(result.data, dz, x, y);

      if (pixels) {
        pendingFetches.delete(key);
        tileDataCache.set(key, pixels);
        tileEpoch.set(key, cacheEpoch);
        repaintCallback?.();
        return;
      }
    } catch (err) {
      console.warn(`[overzoom] error at pz=${pz} px=${px} py=${py}:`, err);
    }
  }

  pendingFetches.delete(key);
  notFoundTiles.add(key);
  tileEpoch.set(key, cacheEpoch);
}

async function decodeAndCropTile(
  data: ArrayBuffer,
  dz: number,
  childX: number,
  childY: number,
): Promise<Uint8Array | null> {
  try {
    const blob = new Blob([data], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);

    const divisor = 1 << dz;
    const localX = childX & (divisor - 1);
    const localY = childY & (divisor - 1);
    const srcSize = bitmap.width / divisor;

    const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(
      bitmap,
      localX * srcSize, localY * srcSize, srcSize, srcSize,
      0, 0, TILE_PX, TILE_PX,
    );
    const imgData = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
    const result = new Uint8Array(imgData.data.buffer);
    cleanNodataFringe(result);
    return result;
  } catch {
    return null;
  }
}

function cleanNodataFringe(pixels: Uint8Array) {
  for (let i = 0; i < pixels.length; i += 4) {
    // If it's mostly transparent, force to absolute nodata
    if (pixels[i + 3] < 128) {
      pixels[i] = 0;
      pixels[i + 1] = 0;
      pixels[i + 2] = 0;
      pixels[i + 3] = 0;
    } else {
      // Force fully opaque
      pixels[i + 3] = 255;
      // If RGB ended up at exactly 0 through blending, but it's an opaque data pixel, bump it to 1
      if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) {
        pixels[i] = 1;
        pixels[i + 1] = 1;
        pixels[i + 2] = 1;
      }
    }
  }
}

async function decodePngToRGBA(data: ArrayBuffer): Promise<Uint8Array | null> {
  try {
    const blob = new Blob([data], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX);
    const imgData = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
    const result = new Uint8Array(imgData.data.buffer);
    cleanNodataFringe(result);
    return result;
  } catch {
    return null;
  }
}

export function flushAxisCache(axis: string) {
  for (const key of tileDataCache.keys()) {
    if (key.startsWith(`${axis}/`)) {
      tileDataCache.delete(key);
    }
  }
  for (const key of pendingFetches) {
    if (key.startsWith(`${axis}/`)) {
      pendingFetches.delete(key);
    }
  }
}

export function flushAllRealDataCache() {
  cacheEpoch++;
  pendingFetches.clear();
  notFoundTiles.clear();
  // Keep old data in cache as fallback while new tiles load;
  // stale entries are detected by mismatched epoch and will be re-fetched.
  // Limit total cache size to prevent unbounded growth across many year changes.
  if (tileDataCache.size > 4000) {
    tileDataCache.clear();
    tileEpoch.clear();
  }
}
