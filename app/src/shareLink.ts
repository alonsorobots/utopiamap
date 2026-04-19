// Read-only permalink encoding/decoding for the Utopia URL fragment.
//
// The complete app state (curves, formula, axis, view, year, optional draw
// mask) is serialised to JSON, gzip-compressed via the browser's native
// CompressionStream, then base64url-encoded into the URL fragment as
// `#view=<blob>`. Nothing leaves the client -- the fragment never reaches
// the server, so there is no backend involved.
//
// Typical encoded payload sizes (verified locally):
//   - Default state:                    ~250  bytes
//   - State with formula + custom curves: ~600 bytes
//   - State with small draw mask:        ~1500 bytes
// Browsers handle ~32 KB hashes without trouble, so we have room.

import type { CurvePoint } from './CurveEditor';
import type { PaintedMask } from './heatmapLayer';

export interface ShareableState {
  curves: Record<string, CurvePoint[]>;
  units: Record<string, string>;
  formula: string;
  activeAxis: string;
  mapCenter: [number, number];
  mapZoom: number;
  year: number;
  mask?: PaintedMask;
}

const HASH_PREFIX_VIEW = 'view=';
const HASH_PREFIX_ROOM = 'room=';

function toBase64Url(bytes: Uint8Array): string {
  // btoa wants a binary string; chunk to avoid blowing the call stack on
  // large inputs (Uint8Array supports apply but only up to ~64K chars).
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function encodeStateToHash(state: ShareableState): Promise<string> {
  const json = JSON.stringify(state);
  const utf8 = new TextEncoder().encode(json);
  const zipped = await gzip(utf8);
  return HASH_PREFIX_VIEW + toBase64Url(zipped);
}

export async function decodeStateFromHash(hash: string): Promise<ShareableState | null> {
  // Accept either "view=..." or "#view=..." or "view=...,key" (the legacy
  // collab-room format kept the room id and key after a comma).
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  let prefix: string | null = null;
  if (raw.startsWith(HASH_PREFIX_VIEW)) prefix = HASH_PREFIX_VIEW;
  else if (raw.startsWith(HASH_PREFIX_ROOM)) prefix = HASH_PREFIX_ROOM;
  if (!prefix) return null;
  raw = raw.slice(prefix.length);
  const comma = raw.indexOf(',');
  if (comma >= 0) raw = raw.slice(0, comma);
  if (!raw) return null;

  try {
    const zipped = fromBase64Url(raw);
    const utf8 = await gunzip(zipped);
    const json = new TextDecoder().decode(utf8);
    const parsed = JSON.parse(json) as ShareableState;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isShareHash(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return raw.startsWith(HASH_PREFIX_VIEW) || raw.startsWith(HASH_PREFIX_ROOM);
}
