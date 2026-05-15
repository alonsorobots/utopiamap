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

// Stop retrying after this many consecutive failures so a perma-down
// relay (or a 429 from the free-tier daily cap) doesn't busy-loop the
// browser. Surfaces as status.error = 'unavailable' / 'rate-limited'
// so the UI can degrade gracefully.
const MAX_CONNECT_FAILURES = 5;

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
  // Per-axis curves and units (the "preferences" people tune in the
  // graph editor). Stored as a flat record so a single peer edit only
  // touches one axis instead of churning the entire blob.
  curves?: Record<string, Array<{ x: number; y: number }>>;
  units?: Record<string, string>;
}

export interface PeerCursor {
  clientId: number;
  // Stable per-human identifier (localStorage seeded). Used to
  // dedupe peers across page refreshes -- without it, a refresh
  // briefly looks like a brand-new join because Y.Awareness keeps the
  // departed clientID around for ~30s before timing out.
  userId: string;
  name: string;
  color: string;
  // Selected axis per peer, for the presence chip in the UI.
  axis?: string;
}

export interface CollabStatus {
  state: 'disconnected' | 'connecting' | 'connected';
  peerCount: number;
  // When we give up reconnecting (the relay is down, we've hit
  // worker free-tier capacity, or our socket got closed for policy
  // violation), surface that to the UI so the share modal can swap
  // the collab button for a "live collab busy, share read-only
  // instead" message instead of letting users copy a link that won't
  // actually work.
  error?: 'rate-limited' | 'unavailable' | null;
}

type StatusListener = (s: CollabStatus) => void;
type CursorListener = (peers: PeerCursor[]) => void;

export class Collab {
  readonly doc: Y.Doc;
  readonly state: Y.Map<unknown>;            // shared SharedView fields
  readonly awareness: awarenessProtocol.Awareness;
  readonly userId: string;

  private ws: WebSocket | null = null;
  private url: string;
  private reconnectDelay = RECONNECT_MIN;
  private destroyed = false;
  private statusListeners = new Set<StatusListener>();
  private cursorListeners = new Set<CursorListener>();
  private status: CollabStatus = { state: 'disconnected', peerCount: 0, error: null };

  // Joiner race control. When we open a fresh tab on an existing room
  // (#room=<id> in the URL) the React app immediately tries to publish
  // its local default state -- "axis=temp", "formula=temp", year=2025 --
  // *before* the room's real state arrives over the wire. Yjs treats
  // those default writes as concurrent with the room's prior writes
  // and resolves the conflict by clientID, which is random; so half
  // the time the joiner's defaults overwrite the room's real state
  // and "collab does nothing".
  //
  // Fix: stash early publishes in `pendingPatch` until we've heard
  // from a peer. When a remote sync arrives we DROP the pending patch
  // (the room's state is canonical; our React tree will be updated by
  // the observer, and the next render's publishView call will be a
  // deepEqual no-op). When we're the only one in the room (creator
  // mode, or the timer below fires), we flush the pending patch so we
  // become the source of truth instead.
  private isPublishing: boolean;
  private pendingPatch: SharedView = {};
  private aloneTimeout: ReturnType<typeof setTimeout> | null = null;

  // Connection-failure tracking for graceful degradation (see
  // MAX_CONNECT_FAILURES). Reset whenever a socket actually opens.
  private consecutiveFailures = 0;

  constructor(roomBaseUrl: string, roomId: string, opts: { joining: boolean } = { joining: false }) {
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

    // Persistent identity. localStorage (not sessionStorage) so the
    // *same human* in the *same browser* keeps the same explorer name
    // across page refreshes and across days. The userId is a tiny
    // stable hash exposed via awareness so peers can dedupe a refresh
    // (otherwise the freshly-allocated Y.Doc clientID makes a reload
    // look like a stranger joining for ~30 seconds, until the old
    // awareness entry times out).
    const persisted = readPersistedIdentity();
    const seed = persisted.seed ?? Math.floor(Math.random() * 1e9);
    const color = persisted.color ?? COLOR_PALETTE[seed % COLOR_PALETTE.length];
    const name = persisted.name ?? randomExplorerName(seed);
    const userId = persisted.userId ?? generateUserId();
    writePersistedIdentity({ seed, name, color, userId });
    this.userId = userId;
    this.awareness.setLocalStateField('user', { name, color, userId });

    // Creator publishes immediately -- they're seeding the room. Joiner
    // defers until the first remote sync arrives (or the alone-timer
    // fires below if the room turns out to be empty).
    this.isPublishing = !opts.joining;
    if (opts.joining) {
      // If nobody responds within this window assume we're orphaned in
      // the room (the creator already left, etc.) and start publishing
      // our own state so the next joiner has *something* to sync to.
      this.aloneTimeout = setTimeout(() => this.enablePublishing(true), 4000);
    }

    this.connect();
  }

  // Promote ourselves out of "joining, waiting for sync" mode.
  // `flushLocal=true` means we never heard from anyone -> publish the
  // pending patch so we become the room's source of truth.
  // `flushLocal=false` means a peer's data arrived -> drop pending
  // (we'd rather adopt the room's state than overwrite it).
  private enablePublishing(flushLocal: boolean) {
    if (this.isPublishing) return;
    if (this.aloneTimeout != null) {
      clearTimeout(this.aloneTimeout);
      this.aloneTimeout = null;
    }
    this.isPublishing = true;
    const pending = this.pendingPatch;
    this.pendingPatch = {};
    if (flushLocal && Object.keys(pending).length > 0) {
      this.applyLocalView(pending);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  applyLocalView(patch: SharedView) {
    if (!this.isPublishing) {
      // Joiner waiting for the room's state -- stash the latest value
      // for each key. We only keep the *last* value per key so the
      // (eventual) flush isn't a stale replay.
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        (this.pendingPatch as Record<string, unknown>)[k] = v;
      }
      return;
    }
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (this.deepEqual(this.state.get(k), v)) continue;
        this.state.set(k, v as unknown);
      }
    }, 'local');
  }

  // Updates which axis we're "looking at" so peers can show that
  // info on our presence chip. Only fires an awareness broadcast when
  // the axis actually changed -- a no-op set still counts as one
  // billable Workers request on the free plan.
  setLocalAxis(axis: string) {
    const cur = (this.awareness.getLocalState() ?? {}) as Record<string, unknown>;
    if (cur.axis === axis) return;
    this.awareness.setLocalState({ ...cur, axis });
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
    if (this.aloneTimeout != null) {
      clearTimeout(this.aloneTimeout);
      this.aloneTimeout = null;
    }
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
    this.setStatus({ state: 'connecting', peerCount: this.status.peerCount, error: this.status.error ?? null });

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
      this.consecutiveFailures = 0;
      this.setStatus({ state: 'connected', peerCount: this.status.peerCount, error: null });

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

    ws.addEventListener('close', (ev) => {
      this.ws = null;
      // Bump failure counter only when the socket never reached an
      // open state (otherwise it'd grow forever during a long-lived
      // session that just had a transient disconnect).
      if (this.status.state !== 'connected') this.consecutiveFailures += 1;

      const giveUp = this.consecutiveFailures >= MAX_CONNECT_FAILURES
        // Code 1008 = the worker explicitly told us we're rate-limited.
        // Don't reconnect on the same identity -- it'll just bounce
        // again. Surface the error and let the user share read-only.
        || ev.code === 1008;

      const errorKind: CollabStatus['error'] = giveUp
        ? (ev.code === 1008 ? 'rate-limited' : 'unavailable')
        : (this.status.error ?? null);
      this.setStatus({ state: 'disconnected', peerCount: 0, error: errorKind });

      // Mark all remote clients as gone so their cursors disappear.
      const remoteClients = Array.from(this.awareness.getStates().keys())
        .filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, remoteClients, 'remote');
      this.fanOutCursors();

      if (!giveUp) this.scheduleReconnect();
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
      // First sync from a peer = somebody is here with real state. Drop
      // our pending defaults and let their state win; the React tree
      // will absorb the remote values via the Y.Map observer and
      // subsequent local publishes will be deepEqual no-ops.
      if (!this.isPublishing) this.enablePublishing(false);
      // Only forward the reply if it contains useful data. readSyncMessage
      // writes nothing for SyncStep2/Update messages, so skip empty frames.
      if (subtype === syncProtocol.messageYjsSyncStep1) {
        this.send(encoding.toUint8Array(reply));
      }
    } else if (messageType === MSG_AWARENESS) {
      const beforeIds = new Set(this.awareness.getStates().keys());
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        'remote',
      );
      this.fanOutCursors();
      // If this awareness brought us a peer we hadn't seen before,
      // re-broadcast our own awareness so they can see *us*. Without
      // this, a late joiner stays invisible to the existing peers
      // forever (we sent our awareness once on WebSocket open, but
      // the room was empty then so it went to the void). Y.Awareness
      // is clock-gated, so the round-trip terminates -- the joiner
      // already has our latest clock for ourselves and discards the
      // duplicate idempotently.
      const afterIds = this.awareness.getStates().keys();
      let sawNewPeer = false;
      for (const id of afterIds) {
        if (id === this.doc.clientID) continue;
        if (!beforeIds.has(id)) { sawNewPeer = true; break; }
      }
      if (sawNewPeer) this.republishOwnAwareness();
    }
  }

  // Encode our own awareness (and only our own) and send it. Used to
  // greet late joiners so they don't have to wait for us to wiggle the
  // mouse before they can see our presence.
  private republishOwnAwareness() {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoding.toUint8Array(enc));
  }

  // ── Cursor fan-out ───────────────────────────────────────────────

  private collectCursors(): PeerCursor[] {
    // Dedupe by userId: when a peer reloads the page, Y.Awareness keeps
    // their pre-refresh entry around for ~30 seconds before it times
    // out, so without deduping a refresh briefly looks like a brand
    // new person joining. We keep the entry with the highest clientID
    // (Y.Doc allocates a new monotonic clientID per session, so the
    // largest one is always the most recent connection).
    const byUser = new Map<string, PeerCursor & { _self: boolean }>();
    let preferredOwnClient = -1;
    for (const [clientId, raw] of this.awareness.getStates()) {
      const st = raw as Record<string, unknown>;
      const user = (st.user ?? {}) as { name?: string; color?: string; userId?: string };
      const userId = typeof user.userId === 'string'
        ? user.userId
        // Fall back to the clientId so peers without an explicit userId
        // still occupy their own slot rather than colliding.
        : `client-${clientId}`;
      const isSelf = userId === this.userId;
      // Track the freshest clientID we've seen for ourselves so the
      // refreshed-self awareness entry shadows the stale pre-refresh
      // one in the dedupe map below.
      if (isSelf) preferredOwnClient = Math.max(preferredOwnClient, clientId);
      const candidate: PeerCursor & { _self: boolean } = {
        clientId,
        userId,
        _self: isSelf,
        name: typeof user.name === 'string' ? user.name : 'guest',
        color: typeof user.color === 'string' ? user.color : '#94a3b8',
        axis: typeof st.axis === 'string' ? st.axis : undefined,
      };
      const existing = byUser.get(userId);
      if (!existing || clientId > existing.clientId) byUser.set(userId, candidate);
    }
    const out: PeerCursor[] = [];
    for (const peer of byUser.values()) {
      if (peer._self) continue;
      // Suppress any stale "ghost" of ourselves that might have leaked
      // through under a different userId (rare; defensive).
      if (peer.clientId === this.doc.clientID) continue;
      const { _self, ...exposed } = peer;
      void _self;
      out.push(exposed);
    }
    void preferredOwnClient;
    return out;
  }

  private fanOutCursors() {
    const peers = this.collectCursors();
    this.setStatus({ state: this.status.state, peerCount: peers.length, error: this.status.error ?? null });
    for (const cb of this.cursorListeners) cb(peers);
  }

  private setStatus(s: CollabStatus) {
    if (
      s.state === this.status.state
      && s.peerCount === this.status.peerCount
      && (s.error ?? null) === (this.status.error ?? null)
    ) return;
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

interface PersistedIdentity {
  seed?: number;
  name?: string;
  color?: string;
  userId?: string;
}

const ID_KEY = 'utopiamap.collab.identity.v2';

function readPersistedIdentity(): PersistedIdentity {
  // localStorage (not sessionStorage) so the same human keeps the same
  // explorer name across page reloads and across days. Falls back to
  // a fresh identity in private windows / when storage is blocked.
  try {
    const raw = localStorage.getItem(ID_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as PersistedIdentity;
  } catch {
    return {};
  }
}

function writePersistedIdentity(v: PersistedIdentity) {
  try {
    localStorage.setItem(ID_KEY, JSON.stringify(v));
  } catch {
    // Ignore (private window etc).
  }
}

function generateUserId(): string {
  // 96 bits is more than enough collision resistance for "is this the
  // same human" dedupe; keep it short to stay legible in dev tools.
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  let s = '';
  for (const b of arr) s += b.toString(16).padStart(2, '0');
  return s;
}

// Deliberately diverse: weighted toward women, people of colour, and
// explorers from outside the European tradition, with a sprinkle of
// fictional captains for fun. The user explicitly requested Cpt. Sully,
// Odysseus, Argonaut, Carl Sagan and Magellan, so they're at the top.
const EXPLORER_NAMES = [
  'Cpt. Sully',
  'Odysseus',
  'Argonaut',
  'Carl Sagan',
  'Magellan',
  // Real-world explorers, scientists, astronauts, navigators
  'Sacagawea',
  'Ibn Battuta',
  'Zheng He',
  'Mae Jemison',
  'Bessie Coleman',
  'Junko Tabei',
  'Hatshepsut',
  'Valentina Tereshkova',
  'Tenzing Norgay',
  'Sylvia Earle',
  'Jane Goodall',
  'Wangari Maathai',
  'Katherine Johnson',
  'Matthew Henson',
  'Ada Blackjack',
  'Marie Tharp',
  'Annie Easley',
  'Gertrude Bell',
  'Maria Sibylla Merian',
  'Yuri Gagarin',
  'Roald Amundsen',
  'Marco Polo',
  'Leif Erikson',
  'Dian Fossey',
  'Mary Leakey',
  'Amelia Earhart',
  'Nellie Bly',
  'Marie Curie',
  'Mary Kingsley',
  'Pytheas',
  'Vasco da Gama',
  'Jacques Cousteau',
  'Edmund Hillary',
  'Hiram Bingham',
  'Roy Chapman Andrews',
  'Gertrude Ederle',
  // Fictional captains and adventurers (tongue-in-cheek)
  'Lt. Uhura',
  'Cpt. Picard',
  'Cpt. Janeway',
  'Lara Croft',
  'Indiana Jones',
  'Dora the Explorer',
  'Doctor Who',
  'Princess Leia',
  'Cpt. Nemo',
];

function randomExplorerName(seed: number): string {
  const idx = Math.abs(seed) % EXPLORER_NAMES.length;
  return EXPLORER_NAMES[idx];
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
