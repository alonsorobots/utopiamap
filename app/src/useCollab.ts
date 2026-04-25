// Glue between the headless `Collab` class and the React app:
//
//   - On mount, opens a session if VITE_COLLAB_URL is configured and
//     either the URL already has a #room= or the caller starts one
//     explicitly via startSession().
//   - Mirrors the "broadcastable" view state (axis / formula / year /
//     scenario) onto a shared Y.Map, applying remote updates exactly
//     once via the supplied callbacks (so this hook never has to know
//     about the heatmap layer or maplibre).
//   - Exposes the live peer cursor list and a status string so the UI
//     can show presence chips and a "share" button.
//
// Outbound updates are coalesced inside Collab (Y.Map.set is a no-op
// when the value already matches) so spamming applyLocalView() with
// every keystroke is fine.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Collab,
  COLLAB_BASE_URL,
  generateRoomId,
  readRoomFromUrl,
  setRoomInUrl,
  type CollabStatus,
  type PeerCursor,
  type SharedView,
} from './collab';

export interface CollabSinks {
  onAxis?: (axis: string) => void;
  onFormula?: (formula: string) => void;
  onYear?: (year: number, scenario: string) => void;
}

export interface UseCollabResult {
  enabled: boolean;
  status: CollabStatus;
  peers: PeerCursor[];
  roomId: string | null;
  shareUrl: string | null;
  startSession: () => string | null;
  endSession: () => void;
  publishView: (patch: SharedView) => void;
  publishCursor: (lngLat: { lng: number; lat: number } | null, axis?: string) => void;
}

export function useCollab(sinks: CollabSinks): UseCollabResult {
  const [roomId, setRoomId] = useState<string | null>(() => readRoomFromUrl());
  const [status, setStatus] = useState<CollabStatus>({ state: 'disconnected', peerCount: 0 });
  const [peers, setPeers] = useState<PeerCursor[]>([]);
  const collabRef = useRef<Collab | null>(null);
  const sinksRef = useRef(sinks);
  sinksRef.current = sinks;

  const enabled = COLLAB_BASE_URL.length > 0;

  useEffect(() => {
    if (!enabled || !roomId) return;
    const c = new Collab(COLLAB_BASE_URL, roomId);
    collabRef.current = c;

    const offStatus = c.onStatus(setStatus);
    const offCursors = c.onCursors(setPeers);

    // Apply remote state changes -> caller's setters. We dispatch the
    // initial state once on mount so a late joiner sees what the room
    // already looks like.
    const applyAll = () => {
      const v = c.state.toJSON() as SharedView;
      const s = sinksRef.current;
      if (typeof v.axis === 'string' && s.onAxis) s.onAxis(v.axis);
      if (typeof v.formula === 'string' && s.onFormula) s.onFormula(v.formula);
      if (typeof v.year === 'number' && s.onYear) {
        s.onYear(v.year, typeof v.scenario === 'string' ? v.scenario : 'historical');
      }
    };
    applyAll();
    const observer = (event: { keysChanged: Set<string> }) => {
      const v = c.state.toJSON() as SharedView;
      const s = sinksRef.current;
      if (event.keysChanged.has('axis') && typeof v.axis === 'string' && s.onAxis) {
        s.onAxis(v.axis);
      }
      if (event.keysChanged.has('formula') && typeof v.formula === 'string' && s.onFormula) {
        s.onFormula(v.formula);
      }
      if (
        (event.keysChanged.has('year') || event.keysChanged.has('scenario')) &&
        typeof v.year === 'number' && s.onYear
      ) {
        s.onYear(v.year, typeof v.scenario === 'string' ? v.scenario : 'historical');
      }
    };
    c.state.observe(observer);

    return () => {
      c.state.unobserve(observer);
      offStatus();
      offCursors();
      c.destroy();
      collabRef.current = null;
      setPeers([]);
      setStatus({ state: 'disconnected', peerCount: 0 });
    };
  }, [enabled, roomId]);

  const startSession = useCallback(() => {
    if (!enabled) return null;
    const existing = readRoomFromUrl();
    if (existing) { setRoomId(existing); return existing; }
    const id = generateRoomId();
    setRoomInUrl(id);
    setRoomId(id);
    return id;
  }, [enabled]);

  const endSession = useCallback(() => {
    setRoomInUrl(null);
    setRoomId(null);
  }, []);

  const publishView = useCallback((patch: SharedView) => {
    const c = collabRef.current;
    if (!c) return;
    c.applyLocalView(patch);
  }, []);

  const publishCursor = useCallback((lngLat: { lng: number; lat: number } | null, axis?: string) => {
    const c = collabRef.current;
    if (!c) return;
    c.setLocalCursor(lngLat?.lng ?? null, lngLat?.lat ?? null, axis);
  }, []);

  const shareUrl = useMemo(() => {
    if (!roomId || typeof window === 'undefined') return null;
    return `${window.location.origin}${window.location.pathname}#room=${roomId}`;
  }, [roomId]);

  return {
    enabled,
    status,
    peers,
    roomId,
    shareUrl,
    startSession,
    endSession,
    publishView,
    publishCursor,
  };
}
