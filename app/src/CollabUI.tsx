// UI bits for real-time collaboration.
//
//   - <CollabBar>  compact strip with the presence count and a row
//     of named peer pills. Each pill is a "jump to where they're
//     looking" button when the peer has published a camera, with a
//     locate icon (the same crosshair-in-circle convention as
//     "find me" on phone maps) so the action is unambiguous.
//
// Per-pixel mouse cursor sharing was removed deliberately to stay
// inside the Cloudflare Workers free plan (100k requests/day) -- the
// mousemove broadcast was the only thing that put real load on the
// relay. Awareness still flows for join/leave + name + active axis,
// plus a debounced per-peer camera so the jump-to-peer chips work,
// which is enough for "we're exploring the same map together".

import type { CollabStatus, PeerCursor } from './collab';

// Material Design "my_location" -- the universally-recognised "find
// me on the map" crosshair-in-circle. Drawn as currentColor so it
// picks up the pill's text colour and stays legible against any
// peer-tint background.
function LocateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
    </svg>
  );
}

interface BarProps {
  enabled: boolean;
  status: CollabStatus;
  peers: PeerCursor[];
  roomId: string | null;
  onEnd: () => void;
  /** Click handler for the peer avatars -- "jump my map to where
   *  they're looking". No-op if the peer hasn't published a camera
   *  yet (just-joined peers, or peers whose tab hasn't moved the map
   *  since opening). */
  onJumpToPeer?: (peer: PeerCursor) => void;
}

export function CollabBar({ enabled, status, peers, roomId, onEnd, onJumpToPeer }: BarProps) {
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
      <div className="collab-peers">
        {peers.slice(0, 6).map((p) => {
          const canJump = !!p.view && !!onJumpToPeer;
          const title = canJump
            ? `Jump to ${p.name}'s view${p.axis ? ` (looking at ${p.axis})` : ''}`
            : `${p.name}${p.axis ? ` -- ${p.axis}` : ''} (no shared view yet)`;
          return (
            <button
              key={p.userId}
              type="button"
              className={`collab-peer${canJump ? ' collab-peer-jumpable' : ''}`}
              // Faint tint of the peer's own colour so a glance at the bar
              // tells you which dot belongs to which name -- without
              // washing out the text the way a saturated background did.
              style={{
                background: tint(p.color, 0.18),
                borderColor: tint(p.color, 0.45),
                color: 'rgba(255,255,255,0.92)',
              }}
              title={title}
              aria-label={title}
              onClick={() => { if (canJump) onJumpToPeer!(p); }}
              disabled={!canJump}
            >
              <span className="collab-peer-dot" style={{ background: p.color }} />
              <span className="collab-peer-name">{firstName(p.name)}</span>
              {canJump && <span className="collab-peer-jump-icon"><LocateIcon /></span>}
            </button>
          );
        })}
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

// Names are pulled from the EXPLORER_NAMES pool, which includes
// titles like "Cpt. Sully" -- strip the title so the pill shows
// "Sully" not "Cpt." -- and otherwise keep the first whitespace
// token so "Carl Sagan" -> "Carl". Whole-name still appears in the
// pill's tooltip.
function firstName(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return 'guest';
  const parts = cleaned.split(/\s+/);
  const TITLE_RE = /^(?:Cpt\.?|Capt\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Lt\.?|Sir|Lord|Lady|Princess|Prince|Doctor)$/i;
  // Skip past leading title tokens until we hit something with letters.
  for (const p of parts) {
    if (!TITLE_RE.test(p)) return p;
  }
  return parts[parts.length - 1];
}

// Mix a peer's hex colour with the panel's dark background so the
// pill is recognisably "theirs" without making the text unreadable.
// `alpha` is the colour's contribution; the rest is panel-dark.
function tint(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'rgba(255,255,255,0.06)';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Blend toward #1a1d23 (the bar background).
  const blend = (c: number) => Math.round(c * alpha + 0x1a * (1 - alpha));
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}
