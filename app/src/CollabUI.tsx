// UI bits for real-time collaboration.
//
//   - <CollabBar>  compact strip with the presence count and a stack
//     of avatar dots so you can see who's connected. Only renders
//     while you're actually inside a room.
//
// Per-pixel mouse cursor sharing was removed deliberately to stay
// inside the Cloudflare Workers free plan (100k requests/day) -- the
// mousemove broadcast was the only thing that put real load on the
// relay. Awareness still flows for join/leave + name + active axis,
// which is enough for "we're looking at the same map together".

import type { CollabStatus, PeerCursor } from './collab';

interface BarProps {
  enabled: boolean;
  status: CollabStatus;
  peers: PeerCursor[];
  roomId: string | null;
  onEnd: () => void;
}

export function CollabBar({ enabled, status, peers, roomId, onEnd }: BarProps) {
  // The "start a session" affordance lives inside the share modal
  // (the same button you use to copy a read-only link), so the bar
  // only renders once we're actually in a room. Outside of a room
  // there's nothing useful to show.
  if (!enabled || !roomId) return null;

  return (
    <div className="collab-bar">
      <span className="collab-presence" title={statusLabel(status)}>
        <span className={`collab-dot collab-dot-${status.state}`} />
        {peers.length === 0 ? 'just you' : `${peers.length + 1} here`}
      </span>
      <div className="collab-avatars">
        {peers.slice(0, 6).map((p) => (
          <span
            key={p.userId}
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
    </div>
  );
}

function statusLabel(s: CollabStatus): string {
  if (s.error === 'rate-limited') return 'rate limited (this tab sent too many updates -- reload to reconnect)';
  if (s.error === 'unavailable') return 'relay unreachable (try the read-only link in Share)';
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
