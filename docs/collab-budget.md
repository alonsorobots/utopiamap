# Collaboration request budget

Single source of truth for **how many relay requests each UI action
should cost**. Anything the live debug panel reports above these
numbers is a leak; chase it.

## Why this matters

Each WebSocket frame the client sends to `collab.utopiamap.com`
counts as **one Cloudflare Workers request AND one Durable Object
request** (the worker forwards into the room's DO). On Workers Paid:

- $5/mo base buys 10M Workers requests + 12.5M DO requests.
- Beyond that: $0.30 per million Workers requests, $0.20 per million
  DO requests.
- So 1M relay messages ≈ $0.50 of incremental cost.

Inbound messages (peers' updates relayed to us) do **not** count
against our budget separately -- they're already counted as the
sender's outbound. They do count as DO ops on egress though, so
think of each peer broadcast as N×2 ops where N is the room size.

## Per-action expectations

These are **outbound** (client → relay) message counts. Numbers
assume a single tab; multiply by the number of tabs the same human
has open if they're testing alone.

| User action                                 | Expected msgs | Notes                                                     |
| ------------------------------------------- | ------------- | --------------------------------------------------------- |
| Page load — creator (no `#room=`)           | 0             | Doesn't connect until they hit "Collaboration link".      |
| Page load — joiner (`#room=…` in URL)       | 2             | sync step 1 + initial awareness on socket open.           |
| Reload while in a room                      | 2             | Same as joiner; old DO entry times out within ~30s.       |
| New peer joins our room                     | +1            | We re-broadcast our awareness to greet them.              |
| Click axis in hamburger menu                | **2**         | One `view.axis` (doc state) + one `aware.axis` (presence). See note. |
| Cycle axis with arrow keys                  | **2**         | Same as click: doc + awareness. One pair per arrow press. |
| Type into formula bar                       | 0             | Suppressed until commit.                                  |
| Press Enter / blur in formula bar           | 1             | One Y.Map set on `formula`.                               |
| Drag a curve point                          | 0             | Suppressed during drag.                                   |
| Release curve drag (300ms idle after)       | 1             | One Y.Map set on `curves` (whole map).                    |
| Scrub timeline                              | 0             | Suppressed during scrub.                                  |
| Release scrub (300ms idle after)            | 1             | One Y.Map set on `year` (+ `scenario`).                   |
| Pan / zoom map (idle settle)                | 0 or 1        | `aware.camera` debounced 2s + skip if change is trivial.  |
| Click peer avatar to jump to them           | 0             | Reads their last-published awareness; we don't talk back. |
| Mouse move on map                           | **0**         | Live cursor sharing was removed for cost reasons.         |
| Paint a stroke (any length)                 | 1             | `view.mask` on stroke end -- whole mask, delta-encoded.   |
| Erase a stroke (any length)                 | 1             | Same path; one msg per release.                           |
| Open share modal                            | 0             | Pure UI.                                                  |
| Copy read-only link                         | 0             | Encoded in the URL, never touches the relay.              |
| Copy collab link (no room yet)              | 1             | Open WebSocket = 1 GET upgrade = 1 worker request.        |
| Copy collab link (already in room)          | 0             | Reuses existing socket.                                   |
| Leave session ("Leave" button)              | 0             | Closes socket; no message sent.                           |

## Per-minute idle baselines

- Solo user, idle (no map interaction): **0 msgs/min**.
- Solo user, slowly tweaking one curve: ~1 msg every 3s = **20/min**.
- 2 users actively editing: ~30 msgs/min combined.

## Per-socket cap (defence in depth)

The worker hard-limits any single WebSocket to **60 messages per
60-second window**. If the live debug panel ever gets close to that
ceiling for a single tab without the user doing something
genuinely intense, that's a leak — fix it before relaxing the cap.

## Worst-case napkin math

- Heavy single user, 60 messages/minute sustained for an hour =
  3,600 msgs/hr ≈ 86k msgs/day. One tab, one user.
- Same intensity, 100 concurrent users: 8.6M msgs/day = ~$0 because
  we're under the included quota for the month after a few days.
- Reddit hug: 1,000 concurrent users active for 1 hour =
  1k × 60 × 60 = 3.6M msgs in an hour. Still inside monthly quota.

If actual measured numbers are higher than this, *something is
spamming* — find it via the per-category counters in the debug
panel.

## Open questions / known unknowns

- **Axis change costs 2 messages**: one `view.axis` for the canonical
  doc state (so future joiners see the right map) and one
  `aware.axis` for presence (so the chip says "Carl Sagan is on
  temp"). Since everyone in a room is looking at the same axis
  anyway, the awareness one is arguably redundant — could be dropped
  to halve axis-change cost. Worth measuring before deciding.
- **Camera publish under sustained panning**: with the 2s debounce
  in place, an actively-exploring user maxes at ~30 msg/min for
  camera. A 5-person room where everyone is panning at once could
  hit ~150 msg/min total in the room. Worth measuring on the debug
  panel under real load before relaxing the debounce.
- **Initial sync size**: a fresh joiner pulls the full room state
  in one frame. Counts as 1 message but byte-size scales with how
  much state is in the doc. Measure for rooms with large `curves`
  blobs.
- **DO duration GB-seconds**: the per-message cap doesn't bound
  long-lived idle sockets' wall time. Hibernation should make this
  free, but worth eyeballing in the Workers analytics dashboard if
  bills get weird.

## Using the debug panel

Append `?debug=1` (or `#debug=1`) to any utopiamap URL to enable.

Workflow:

1. Pick a row in the table above ("press Enter in formula bar = 1").
2. Open the panel; click reset.
3. Perform the action exactly once.
4. Read the per-category count.
5. If it doesn't match the spec, you've found a leak (or this doc
   is stale — update the spec).
