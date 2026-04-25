# utopiamap-collab worker

A ~120-line Cloudflare Worker + Durable Object that relays Yjs sync and
awareness messages between everyone connected to the same `/room/<id>`
WebSocket. Powers the "Share session" button in the main app.

## Why Cloudflare Durable Objects

- Free tier covers casual use ("send this link to my friend"): ~100k
  requests/day and 13k GB-s of DO duration are included.
- Built-in WebSocket hibernation -- idle rooms cost nothing.
- Single global namespace: `idFromName("abc123")` always lands on the same
  DO worldwide, so peers in different regions actually meet.
- No database, no cron, no per-user state. The relay never inspects the
  bytes; a room exists for as long as someone is connected and then
  evaporates.

## Privacy model

Same as Excalidraw shares: knowing the room id is the only access
boundary. URLs use random 12-char ids generated client-side and live in
the URL hash, so they never go into HTTP referrers or server logs.

The relay does NOT persist messages, so closing the last tab clears the
session. If you want stronger guarantees later we can add an end-to-end
encryption layer where the room key lives in the URL fragment and the
worker only ever sees ciphertext.

## Develop

```sh
npm install
npm run dev      # starts a local wrangler dev server on :8787
```

Then point the frontend at it by setting `VITE_COLLAB_URL=ws://localhost:8787/room/`
in `app/.env.local`.

## Deploy

```sh
npm run deploy
```

The first deploy creates the worker at
`https://utopiamap-collab.<your-subdomain>.workers.dev`. To attach a
custom domain (recommended for the production frontend), add
`collab.utopiamap.com` as a Workers custom domain in the Cloudflare
dashboard. Then set the production env var
`VITE_COLLAB_URL=wss://collab.utopiamap.com/room/`.
