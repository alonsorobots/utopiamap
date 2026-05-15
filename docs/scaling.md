# What to do if utopiamap.com goes viral

This is a one-page playbook for keeping the site online (and your wallet
intact) if a Reddit/HN post lands and traffic spikes 100x overnight.

The serving stack is built so the **static map and read-only links keep
working at essentially infinite scale on the free plan**. The only thing
that has a hard ceiling is the real-time collab relay. If that ceiling
is hit, the site degrades gracefully -- read-only links still work --
and you get a chance to decide whether the moment is big enough to flip
on paid billing.

---

## What's where

| Layer                | Service                | Free-tier ceiling                  | Hard cap?                 |
| -------------------- | ---------------------- | ---------------------------------- | ------------------------- |
| `app/` static SPA    | Cloudflare Pages       | Unlimited bandwidth, 500 builds/mo | No (just rebuilds)        |
| `tiles/*.pmtiles`    | Cloudflare R2 + Pages  | 10 GB egress/day free              | No (per-byte pricing)     |
| `collab-worker/`     | Workers + Durable Obj. | 100k requests/day, 13M DO ops/mo   | **Yes, by default**       |

Static traffic is essentially free. The collab worker is the only
bottleneck.

---

## Built-in defences (already shipped)

- **Per-socket rate limit (`collab-worker/src/worker.ts`)**: each
  WebSocket can send at most 60 messages per minute. Above that the
  worker closes the socket with code `1008` so a single buggy or
  malicious client can't drain the daily budget for everyone else.
- **Client-side debouncing (`app/src/App.tsx`)**:
  - Formula: published only on Enter / blur (not per keystroke).
  - Curve drags: 300 ms idle debounce.
  - Year scrubs: 300 ms idle debounce.
  - Live cursor sharing: removed entirely.
- **Hybrid share links (`app/src/shareLink.ts`)**: collab links carry
  both `view=<snapshot>` and `room=<id>`. If the relay is offline or
  rate-limited, recipients still see the static snapshot.
- **Graceful degradation (`app/src/collab.ts`)**: after 5 consecutive
  connection failures or a `1008` close, the client stops retrying and
  surfaces the failure to the share modal, which swaps the collab
  button for a "send a read-only link instead" message.

So even if the worker is dead, the site itself never goes down.

---

## When to upgrade

Upgrade only if **the collab feature itself is the reason people came**
and you're seeing the share modal show "rate limited" / "unavailable"
in your own testing. For pure tile traffic, the free plan is fine.

Signals to watch:

1. Cloudflare dashboard -> Workers -> Analytics: requests/day
   approaching 100k.
2. Reports of users seeing "rate limited" in the share modal.
3. Cloudflare dashboard -> R2 -> Class A operations approaching free
   tier (10M/month).

---

## Upgrade in 5 minutes (under $5/month if quiet)

1. **Workers Paid plan: $5/month base, then usage**
   - Cloudflare dashboard -> Workers & Pages -> Plans -> Workers Paid.
   - Includes: 10M requests/month, 12.5M DO requests/month, generous
     CPU. Beyond that it's pennies per million.
2. **Set a hard spending cap (CRITICAL)**
   - Account -> Billing -> Notifications -> Add usage notification at
     e.g. $20/month.
   - There is **no automatic spending cap** on Cloudflare; you must
     manually review and (if needed) downgrade. Set a calendar
     reminder for monthly billing day.
3. **Add R2 budget alert too** if tile traffic is also growing.
4. **No code changes needed**: the worker already handles burst
   traffic, the per-socket rate limit still applies (so a bad actor
   can't run up an unbounded bill).
5. **If the rate-limited share-modal message keeps appearing** even
   after upgrade: bump `MAX_MSGS_PER_WINDOW` in
   `collab-worker/src/worker.ts` from 60 to e.g. 120, redeploy with
   `cd collab-worker && wrangler deploy`.

## Downgrade

When the storm passes, just switch the plan back to Free in the same
dashboard page. No data loss; the collab DO is ephemeral by design.

---

## Nuclear option: take collab offline temporarily

If the relay is melting and you don't want to pay yet:

1. Cloudflare dashboard -> Workers & Pages -> `utopiamap` worker ->
   Triggers -> remove the `collab.utopiamap.com` route.
2. The frontend detects the failure and falls back to read-only
   sharing automatically.
3. To re-enable, re-add the route -- no code change needed.

The static site, the tiles, and the read-only sharing keep working
through all of this.
