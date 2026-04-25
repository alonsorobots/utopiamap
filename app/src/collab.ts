// Real-time collaboration glue.
//
// Wires a Yjs document up to the utopiamap-collab worker via WebSocket and
// mirrors the app's UI state into a shared Y.Map so every collaborator
// sees the same axis / year / formula / camera in real time. Cursor
// positions ride on Y.Awareness instead of the doc, so they don't bloat
// the persistent state.
//
// Wire format follows the standard y-websocket protocol:
//   byte 0: messageType
//     0  = sync       (followed by y-protocols/sync sub-message)
//     1  = awareness  (followed by y-protocols/awareness payload)
//   subsequent bytes: protocol-defined payload
//
// We never persist the doc to the relay -- the relay is a dumb byte
// forwarder. When the last peer leaves, the room evaporates.

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// Cap reconnect backoff so we don't spam the worker if it's down.
const RECONNECT_MIN = 500;
const RECONNECT_MAX = 15_000;

const COLOR_PALETTE = [
  '#f87171', '#fb923c', '#facc15', '#4ade80', '#34d399',
  '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6', '#e879f9',
];

export interface SharedView {
  axis?: string;
  formula?: string;
  year?: number;
  scenario?: string;
  // Keyed view so partial updates don't clobber the whole camera.
  view?: { lng: number; lat: number; zoom: number };
}

export interface PeerCursor {
  clientId: number;
  name: string;
  color: string;
  // Geographic coords -- so each peer renders the cursor in its own
  // projection regardless of zoom or pan offset.
  lng: number;
  lat: number;
  // Selected axis per peer, for the presence chip in the UI.
  axis?: string;
}

export interface CollabStatus {
  state: 'disconnected' | 'connecting' | 'connected';
  peerCount: number;
}

type StatusListener = (s: CollabStatus) => void;
type CursorListener = (peers: PeerCursor[]) => void;

export class Collab {
  readonly doc: Y.Doc;
  readonly state: Y.Map<unknown>;            // shared SharedView fields
  readonly awareness: awarenessProtocol.Awareness;

  private ws: WebSocket | null = null;
  private url: string;
  private reconnectDelay = RECONNECT_MIN;
  private destroyed = false;
  private statusListeners = new Set<StatusListener>();
  private cursorListeners = new Set<CursorListener>();
  private status: CollabStatus = { state: 'disconnected', peerCount: 0 };

  constructor(roomBaseUrl: string, roomId: string) {
    this.doc = new Y.Doc();
    this.state = this.doc.getMap('view');
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    const sep = roomBaseUrl.endsWith('/') ? '' : '/';
    this.url = `${roomBaseUrl}${sep}${encodeURIComponent(roomId)}`;

    // Local Yjs updates -> broadcast to peers.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });

    // Local awareness updates (cursor moved, name changed, ...) -> peers.
    const awarenessChanged = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    ) => {
      const changed = added.concat(updated).concat(removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.send(encoding.toUint8Array(enc));
      this.fanOutCursors();
    };
    this.awareness.on('update', awarenessChanged);

    // Random user identity. Saved per-tab so it doesn't churn between
    // reloads; falls back to a fresh one when sessionStorage isn't
    // available (private windows etc).
    const persisted = readPersistedIdentity();
    const seed = persisted.seed ?? Math.floor(Math.random() * 1e9);
    const color = COLOR_PALETTE[seed % COLOR_PALETTE.length];
    const name = persisted.name ?? randomName(seed);
    writePersistedIdentity({ seed, name });
    this.awareness.setLocalStateField('user', { name, color });

    this.connect();
  }

  // ── Public API ────────────────────────────────────────────────────

  applyLocalView(patch: SharedView) {
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (this.deepEqual(this.state.get(k), v)) continue;
        this.state.set(k, v as unknown);
      }
    }, 'local');
  }

  setLocalCursor(lng: number | null, lat: number | null, axis?: string) {
    const cur = (this.awareness.getLocalState() ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...cur };
    if (lng === null || lat === null) {
      delete next.cursor;
    } else {
      next.cursor = { lng, lat };
    }
    if (axis !== undefined) next.axis = axis;
    this.awareness.setLocalState(next);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  onCursors(cb: CursorListener): () => void {
    this.cursorListeners.add(cb);
    cb(this.collectCursors());
    return () => this.cursorListeners.delete(cb);
  }

  destroy() {
    this.destroyed = true;
    awarenessProtocol.removeAwarenessStates(
      this.awareness, [this.doc.clientID], 'local',
    );
    this.awareness.destroy();
    if (this.ws) {
      try { this.ws.close(1000, 'bye'); } catch {}
      this.ws = null;
    }
    this.doc.destroy();
  }

  // ── WebSocket plumbing ───────────────────────────────────────────

  private connect() {
    if (this.destroyed) return;
    this.setStatus({ state: 'connecting', peerCount: this.status.peerCount });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_MIN;
      this.setStatus({ state: 'connected', peerCount: this.status.peerCount });

      // Initial sync handshake: send our current state vector so peers
      // know what they need to send us. They'll respond with a SyncStep2.
      const sync1 = encoding.createEncoder();
      encoding.writeVarUint(sync1, MSG_SYNC);
      syncProtocol.writeSyncStep1(sync1, this.doc);
      this.send(encoding.toUint8Array(sync1));

      // Push our local awareness so existing peers see us immediately.
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        aw,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      );
      this.send(encoding.toUint8Array(aw));
    });

    ws.addEventListener('message', (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      this.handleIncoming(new Uint8Array(ev.data));
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      this.setStatus({ state: 'disconnected', peerCount: 0 });
      // Mark all remote clients as gone so their cursors disappear.
      const remoteClients = Array.from(this.awareness.getStates().keys())
        .filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, remoteClients, 'remote');
      this.fanOutCursors();
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // The 'close' handler will fire too; nothing to do here.
    });
  }

  private send(payload: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Cast away the SharedArrayBuffer-vs-ArrayBuffer type widening that
      // TS 5.7+ inflicts on Uint8Array. WebSocket.send accepts any view.
      // Copy into a fresh ArrayBuffer so the type is unambiguous (the lib0
      // encoders return Uint8Array<ArrayBufferLike> which TS 5.7 widens to
      // include SharedArrayBuffer, which WebSocket.send rejects at compile
      // time even though it works at runtime).
      const buf = new Uint8Array(payload.byteLength);
      buf.set(payload);
      try { this.ws.send(buf.buffer); } catch {}
    }
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX);
    setTimeout(() => this.connect(), delay);
  }

  private handleIncoming(buf: Uint8Array) {
    const decoder = decoding.createDecoder(buf);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MSG_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      const subtype = syncProtocol.readSyncMessage(decoder, reply, this.doc, 'remote');
      // Only forward the reply if it contains useful data. readSyncMessage
      // writes nothing for SyncStep2/Update messages, so skip empty frames.
      if (subtype === syncProtocol.messageYjsSyncStep1) {
        this.send(encoding.toUint8Array(reply));
      }
    } else if (messageType === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        'remote',
      );
      this.fanOutCursors();
    }
  }

  // ── Cursor fan-out ───────────────────────────────────────────────

  private collectCursors(): PeerCursor[] {
    const out: PeerCursor[] = [];
    for (const [clientId, raw] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const st = raw as Record<string, unknown>;
      const user = (st.user ?? {}) as { name?: string; color?: string };
      const cursor = st.cursor as { lng?: number; lat?: number } | undefined;
      out.push({
        clientId,
        name: typeof user.name === 'string' ? user.name : 'guest',
        color: typeof user.color === 'string' ? user.color : '#94a3b8',
        lng: cursor?.lng ?? NaN,
        lat: cursor?.lat ?? NaN,
        axis: typeof st.axis === 'string' ? st.axis : undefined,
      });
    }
    return out;
  }

  private fanOutCursors() {
    const peers = this.collectCursors();
    this.setStatus({ state: this.status.state, peerCount: peers.length });
    for (const cb of this.cursorListeners) cb(peers);
  }

  private setStatus(s: CollabStatus) {
    if (s.state === this.status.state && s.peerCount === this.status.peerCount) return;
    this.status = s;
    for (const cb of this.statusListeners) cb(s);
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
}

// ── Identity helpers ────────────────────────────────────────────────

const ID_KEY = 'utopiamap.collab.identity';

function readPersistedIdentity(): { seed?: number; name?: string } {
  try {
    const raw = sessionStorage.getItem(ID_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writePersistedIdentity(v: { seed: number; name: string }) {
  try {
    sessionStorage.setItem(ID_KEY, JSON.stringify(v));
  } catch {
    // Ignore (private window etc).
  }
}

const ADJECTIVES = [
  'wandering', 'sunlit', 'curious', 'jagged', 'distant', 'misty',
  'electric', 'verdant', 'ember', 'glacial', 'tidal', 'gilded',
];
const ANIMALS = [
  'fox', 'otter', 'crane', 'lynx', 'heron', 'panda', 'kestrel',
  'mantis', 'narwhal', 'koi', 'wolf', 'finch',
];

function randomName(seed: number): string {
  const a = ADJECTIVES[seed % ADJECTIVES.length];
  const b = ANIMALS[(seed >> 8) % ANIMALS.length];
  return `${a} ${b}`;
}

// ── Room id helpers ─────────────────────────────────────────────────

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';

export function generateRoomId(len = 12): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[arr[i] % ALPHABET.length];
  return out;
}

export function readRoomFromUrl(): string | null {
  try {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const room = params.get('room');
    if (room && /^[a-zA-Z0-9_-]{1,128}$/.test(room)) return room;
    return null;
  } catch {
    return null;
  }
}

export function setRoomInUrl(roomId: string | null) {
  try {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    if (roomId) params.set('room', roomId); else params.delete('room');
    const newHash = params.toString();
    const url = `${window.location.pathname}${window.location.search}${newHash ? '#' + newHash : ''}`;
    window.history.replaceState({}, '', url);
  } catch {
    // Ignore -- we'll fall back to in-memory state.
  }
}

export const COLLAB_BASE_URL = (import.meta.env.VITE_COLLAB_URL as string | undefined) ?? '';
