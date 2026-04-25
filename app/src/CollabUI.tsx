// UI bits for real-time collaboration.
//
//   - <CollabCursors>  draws each peer's mouse cursor on top of the map,
//     reprojected from their lng/lat into the local viewport.
//   - <CollabBar>      compact strip with the share button, presence
//     count, and a stack of avatar dots so you can see who's connected.
//
// Both components are render-only -- session lifecycle and state sync
// live in useCollab.ts so the components can be swapped out (tooltips,
// fancier presence list, etc.) without touching the protocol layer.

import { useEffect, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import type { CollabStatus, PeerCursor } from './collab';

interface CursorsProps {
  map: maplibregl.Map | null;
  peers: PeerCursor[];
}

export function CollabCursors({ map, peers }: CursorsProps) {
  // Re-render on every map move so projected positions track the camera.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!map) return;
    const onMove = () => bump((n) => n + 1);
    map.on('move', onMove);
    map.on('zoom', onMove);
    return () => {
      map.off('move', onMove);
      map.off('zoom', onMove);
    };
  }, [map]);

  if (!map) return null;

  return (
    <div className="collab-cursor-layer">
      {peers.map((p) => {
        if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return null;
        const pt = map.project([p.lng, p.lat]);
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
        return (
          <div
            key={p.clientId}
            className="collab-cursor"
            style={{ left: pt.x, top: pt.y }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M2 2 L2 16 L6.5 12 L9.2 18.5 L11.7 17.5 L9 11 L14.5 11 Z"
                fill={p.color}
                stroke="rgba(0,0,0,0.55)"
                strokeWidth="0.7"
                strokeLinejoin="round"
              />
            </svg>
            <span className="collab-cursor-name" style={{ background: p.color }}>
              {p.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface BarProps {
  enabled: boolean;
  status: CollabStatus;
  peers: PeerCursor[];
  roomId: string | null;
  shareUrl: string | null;
  onStart: () => void;
  onEnd: () => void;
}

export function CollabBar({ enabled, status, peers, roomId, shareUrl, onStart, onEnd }: BarProps) {
  const [copied, setCopied] = useState(false);

  if (!enabled) return null;

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: prompt the user.
      window.prompt('Copy this link to share:', shareUrl);
    }
  };

  return (
    <div className="collab-bar">
      {!roomId ? (
        <button className="collab-btn" onClick={onStart} title="Start a shared session">
          Share session
        </button>
      ) : (
        <>
          <button
            className="collab-btn"
            onClick={handleCopy}
            title={shareUrl ?? ''}
          >
            {copied ? 'Link copied' : 'Copy invite link'}
          </button>
          <span className="collab-presence" title={statusLabel(status)}>
            <span className={`collab-dot collab-dot-${status.state}`} />
            {peers.length === 0 ? 'just you' : `${peers.length + 1} here`}
          </span>
          <div className="collab-avatars">
            {peers.slice(0, 6).map((p) => (
              <span
                key={p.clientId}
                className="collab-avatar"
                style={{ background: p.color }}
                title={`${p.name}${p.axis ? ` -- ${p.axis}` : ''}`}
              >
                {initials(p.name)}
              </span>
            ))}
          </div>
          <button className="collab-btn collab-btn-end" onClick={onEnd} title="Leave the shared session">
            Leave
          </button>
        </>
      )}
    </div>
  );
}

function statusLabel(s: CollabStatus): string {
  if (s.state === 'connected') return 'connected';
  if (s.state === 'connecting') return 'connecting...';
  return 'disconnected (will retry)';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
